import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../utils/config';
import logger from '../utils/logger';
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';

const API_BASE_URL = config.SPEECHLAB_API_URL || 'https://api-translate-dev.speechlab.ai/v1';

// Interfaces for API Payloads and Responses (based on user examples)
interface LoginPayload {
    email: string;
    password: string;
}

interface LoginResponse {
    tokens: {
        accessToken: {
            jwtToken: string;
        };
        // Include other potential fields if needed, e.g., refreshToken, idToken
    };
    // Add other potential fields if present in the actual response
}

interface CreateDubPayload {
    name: string;
    sourceLanguage: string;
    targetLanguage: string;
    dubAccent: string;
    unitType: string; // e.g., 'whiteGlove'
    mediaFileURI: string;
    voiceMatchingMode: 'source' | 'native'; // Assuming these are the options
    thirdPartyID: string;
    customizedVoiceMatchingSpeakers?: Array<{
        speaker: string; // e.g., "Speaker 1"
        voiceMatchingMode: 'native'; // Assuming 'native' is the only option here
    }>;
}

interface CreateDubResponse {
    projectId: string; // Assuming the project ID is directly in the response
    // Add other potential fields
}

interface GenerateLinkPayload {
    projectId: string;
}

interface GenerateLinkResponse {
    link: string;
    // Add other potential fields
}

// Define the structure for the Dub Media Item (OUTPUTS)
export interface DubMedia {
    _id: string;
    uri: string;
    category: string; 
    contentTYpe: string; // Note the typo in the example API response
    format: string; 
    operationType: string; // Should be OUTPUT
    presignedURL?: string; 
    isSRTUploaded?: boolean;
    // Include other relevant fields
}

// Define the structure for the main Dub object within a Translation
export interface DubObject {
     id?: string; // Or _id
     language?: string;
     voiceMatchingMode?: string;
     isDubUpdated?: boolean;
     mergeStatus?: string;
     lastDubRunType?: string;
     medias?: DubMedia[]; // The array of output media files
     // Include other fields associated with the dub process itself
}

// Define the structure for a Translation object
export interface Translation {
    id: string; // Or _id depending on API
    language: string;
    dub?: DubObject[]; // Dub process results are in an array here
    // Include other translation-specific fields
}

// Define the structure for the Project Details
export interface Project {
    id: string;
    job: {
        name: string;
        sourceLanguage: string;
        targetLanguage: string;
        status: string; 
    };
    translations?: Translation[]; 
    thirdPartyID?: string; // Ensuring thirdPartyID is part of the Project interface
    transcription?: {
        transcriptionText?: string;
        // ... other potential transcription properties from the API response
    };
    // Include other fields from the API response as needed
}

// Update GetProjectsResponse to use the refined Project type
interface GetProjectsResponse {
    results: Array<Project>; 
    totalResults: number;
}

// Simple in-memory cache for the token
let cachedToken: string | null = null;
let tokenExpiryTime: number | null = null; // Store expiry time (optional, needs parsing JWT)

// Create an Axios instance for API calls
const apiClient: AxiosInstance = axios.create({
    baseURL: API_BASE_URL,
    headers: {
        'Content-Type': 'application/json',
    },
    timeout: 30000, // 30 second timeout
});

/**
 * Handles API errors, logging relevant details.
 * @param error The error object (likely AxiosError).
 * @param context Descriptive string for the context where the error occurred.
 */
function handleApiError(error: unknown, context: string): void {
    if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        logger.error(`[🤖 SpeechLab] ❌ API Error during ${context}: ${axiosError.message}`);
        if (axiosError.response) {
            logger.error(`[🤖 SpeechLab] Status: ${axiosError.response.status}`);
            logger.error(`[🤖 SpeechLab] Data: ${JSON.stringify(axiosError.response.data)}`);
            logger.error(`[🤖 SpeechLab] Headers: ${JSON.stringify(axiosError.response.headers)}`);
        } else if (axiosError.request) {
            logger.error('[🤖 SpeechLab] No response received:', axiosError.request);
        } else {
            // Something happened in setting up the request that triggered an Error
             logger.error('[🤖 SpeechLab] Error setting up request:', axiosError.message);
        }
    } else {
        logger.error(`[🤖 SpeechLab] ❌ Non-Axios error during ${context}:`, error);
    }
}

/**
 * Invalidates the cached authentication token.
 */
function invalidateAuthToken(): void {
    logger.info('[🤖 SpeechLab] Invalidating cached authentication token.');
    cachedToken = null;
    tokenExpiryTime = null;
}

/**
 * Authenticates with the SpeechLab API to get a JWT token.
 * Uses simple caching. Add proper JWT expiry check if needed.
 * @returns {Promise<string | null>} The JWT token or null on failure.
 */
async function getAuthToken(): Promise<string | null> {
    // Basic check: If we have a token, return it (improve with expiry check later)
    if (cachedToken) {
        // TODO: Add check for tokenExpiryTime here if implementing JWT parsing
        logger.debug('[🤖 SpeechLab] Using cached authentication token.');
        return cachedToken;
    }

    logger.info('[🤖 SpeechLab] No cached token. Authenticating with API...');
    const loginPayload: LoginPayload = {
        email: config.SPEECHLAB_EMAIL,
        password: config.SPEECHLAB_PASSWORD,
    };

    try {
        const response = await apiClient.post<LoginResponse>('/v1/auth/login', loginPayload);
        const token = response.data?.tokens?.accessToken?.jwtToken;

        if (token) {
            logger.info('[🤖 SpeechLab] ✅ Successfully authenticated and obtained token.');
            cachedToken = token;
            // TODO: Decode JWT to get expiry time and set tokenExpiryTime
            return token;
        } else {
            logger.error('[🤖 SpeechLab] ❌ Authentication successful but token not found in response.');
            logger.debug(`[🤖 SpeechLab] Full login response: ${JSON.stringify(response.data)}`);
            return null;
        }
    } catch (error) {
        handleApiError(error, 'authentication');
        return null;
    }
}

/**
 * Creates a dubbing project in SpeechLab. Handles 401 errors by retrying once after refreshing the token.
 * @param publicAudioUrl The publicly accessible URL of the source audio file (e.g., S3 URL).
 * @param projectName The desired name for the project.
 * @param targetLanguageCode The detected target language code (e.g., 'es').
 * @param thirdPartyId The unique identifier for this job (e.g., spaceId-langCode).
 * @param sourceLanguageCode Optional source language code. If not provided, uses config.SOURCE_LANGUAGE.
 * @returns {Promise<string | null>} The projectId if successful, otherwise null.
 */
export async function createDubbingProject(
    publicAudioUrl: string, 
    projectName: string, 
    targetLanguageCode: string, 
    thirdPartyId: string,
    sourceLanguageCode?: string
): Promise<string | null> {
    logger.info(`[🤖 SpeechLab] Attempting to create dubbing project: Name="${projectName}", Source=${sourceLanguageCode || config.SOURCE_LANGUAGE}, Target=${targetLanguageCode}, 3rdPartyID=${thirdPartyId}`);
    
    let attempt = 1;
    const maxAttempts = 2; // Initial attempt + 1 retry

    // Ensure projectName is reasonably limited
    const finalProjectName = projectName.substring(0, 100);

    // Map 'es' to 'es_la' for API compatibility
    const apiTargetLanguage = targetLanguageCode === 'es' ? 'es_la' : targetLanguageCode;
    const apiDubAccent = targetLanguageCode === 'es' ? 'es_la' : targetLanguageCode;
    logger.debug(`[🤖 SpeechLab] Mapped target language code ${targetLanguageCode} to API targetLanguage: ${apiTargetLanguage}, dubAccent: ${apiDubAccent}`);

    const payload: CreateDubPayload = {
        name: finalProjectName,
        sourceLanguage: sourceLanguageCode || config.SOURCE_LANGUAGE,
        targetLanguage: apiTargetLanguage, // Use mapped code
        dubAccent: apiDubAccent,          // Use mapped code
        unitType: "whiteGlove",
        mediaFileURI: publicAudioUrl,
        voiceMatchingMode: "source",
        thirdPartyID: thirdPartyId,
    };

    logger.debug(`[🤖 SpeechLab] Create project payload (Attempt ${attempt}): ${JSON.stringify(payload)}`);

    while (attempt <= maxAttempts) {
        const token = await getAuthToken();
        if (!token) {
            logger.error(`[🤖 SpeechLab] ❌ Cannot create project (Attempt ${attempt}): Failed to get authentication token.`);
            return null; // Can't proceed without a token
        }

        try {
            const response = await apiClient.post<CreateDubResponse>('/v1/projects/createProjectAndDub', payload, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            const projectId = response.data?.projectId;
            if (projectId) {
                logger.info(`[🤖 SpeechLab] ✅ Successfully created project (Attempt ${attempt}). Project ID: ${projectId} (ThirdPartyID: ${thirdPartyId})`);
                return projectId;
            } else {
                logger.error(`[🤖 SpeechLab] ❌ Project creation API call successful (Attempt ${attempt}) but projectId not found in response.`);
                logger.debug(`[🤖 SpeechLab] Full create project response (Attempt ${attempt}): ${JSON.stringify(response.data)}`);
                return null; // API succeeded but didn't return expected data
            }

        } catch (error) {
            const context = `project creation for ${finalProjectName} (3rdPartyID: ${thirdPartyId}) (Attempt ${attempt})`;
            
            if (axios.isAxiosError(error) && error.response?.status === 401 && attempt < maxAttempts) {
                logger.warn(`[🤖 SpeechLab] ⚠️ Received 401 Unauthorized on attempt ${attempt}. Invalidating token and retrying...`);
                invalidateAuthToken(); // Invalidate the cached token
                attempt++;
                logger.debug(`[🤖 SpeechLab] Create project payload (Attempt ${attempt}): ${JSON.stringify(payload)}`); // Log payload for retry
                continue; // Go to the next iteration to retry
            } else {
                // Handle non-401 errors or failure on the final attempt
                handleApiError(error, context);
                return null;
            }
        }
    }

    // Should theoretically not be reached if logic is correct, but acts as a fallback
    logger.error(`[🤖 SpeechLab] ❌ Failed to create project after ${maxAttempts} attempts.`);
    return null;
}

/**
 * Generates a sharing link for a given SpeechLab project. Handles 401 errors by retrying once after refreshing the token.
 * @param projectId The ID of the project.
 * @returns {Promise<string | null>} The sharing link URL if successful, otherwise null.
 */
export async function generateSharingLink(projectId: string): Promise<string | null> {
    logger.info(`[🤖 SpeechLab] Attempting to generate sharing link for project ID: ${projectId}`);
    
    let attempt = 1;
    const maxAttempts = 2; // Initial attempt + 1 retry

    const payload: GenerateLinkPayload = { projectId };
    logger.debug(`[🤖 SpeechLab] Generate link payload (Attempt ${attempt}): ${JSON.stringify(payload)}`);

    while (attempt <= maxAttempts) {
        const token = await getAuthToken();
        if (!token) {
            logger.error(`[🤖 SpeechLab] ❌ Cannot generate link (Attempt ${attempt}): Failed to get authentication token.`);
            return null;
        }

        try {
            const response = await apiClient.post<GenerateLinkResponse>('/v1/collaborations/generateSharingLink', payload, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            const link = response.data?.link;
            if (link) {
                logger.info(`[🤖 SpeechLab] ✅ Successfully generated sharing link (Attempt ${attempt}): ${link}`);
                return link;
            } else {
                logger.error(`[🤖 SpeechLab] ❌ Link generation successful (Attempt ${attempt}) but link not found in response.`);
                logger.debug(`[🤖 SpeechLab] Full generate link response (Attempt ${attempt}): ${JSON.stringify(response.data)}`);
                return null;
            }
        } catch (error) {
            const context = `sharing link generation for project ${projectId} (Attempt ${attempt})`;
            
            if (axios.isAxiosError(error) && error.response?.status === 401 && attempt < maxAttempts) {
                logger.warn(`[🤖 SpeechLab] ⚠️ Received 401 Unauthorized on attempt ${attempt} for link generation. Invalidating token and retrying...`);
                invalidateAuthToken();
                attempt++;
                logger.debug(`[🤖 SpeechLab] Generate link payload (Attempt ${attempt}): ${JSON.stringify(payload)}`); // Log payload for retry
                continue; 
            } else {
                handleApiError(error, context);
                return null;
            }
        }
    }
    
    logger.error(`[🤖 SpeechLab] ❌ Failed to generate sharing link after ${maxAttempts} attempts.`);
    return null;
}

/**
 * Gets project details by thirdPartyID to check its status.
 * Returns the *full* project object if found.
 * @param thirdPartyID The thirdPartyID used when creating the project
 * @returns {Promise<Project | null>} Full project object if found, otherwise null
 */
export async function getProjectByThirdPartyID(thirdPartyID: string): Promise<Project | null> {
    logger.info(`[🤖 SpeechLab] Getting project status for thirdPartyID: ${thirdPartyID}`);
    
    let attempt = 1;
    const maxAttempts = 2; // Initial attempt + 1 retry

    const encodedThirdPartyID = encodeURIComponent(thirdPartyID);
    const url = `/v1/projects?sortBy=createdAt%3Aasc&limit=1&expand=true&thirdPartyIDs=${encodedThirdPartyID}`;
        
    logger.debug(`[🤖 SpeechLab] 🔍 Fetching project status from API URL (Attempt ${attempt}): ${API_BASE_URL}${url}`);

    while (attempt <= maxAttempts) {
        const token = await getAuthToken();
        if (!token) {
            logger.error(`[🤖 SpeechLab] ❌ Cannot check project status (Attempt ${attempt}): Failed to get authentication token.`);
            return null;
        }

        try {
            const response = await apiClient.get<GetProjectsResponse>(url, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            // Write the *summary* API response to a temporary file for debugging if needed
            const tempFilePath = path.join(process.cwd(), `temp_api_response_summary_${thirdPartyID}_attempt_${attempt}.json`); // Include attempt in filename
            try {
                fsPromises.writeFile(
                    tempFilePath,
                    JSON.stringify({
                        timestamp: new Date().toISOString(),
                        thirdPartyID: thirdPartyID,
                        attempt: attempt, // Add attempt number to summary
                        requestUrl: `${API_BASE_URL}${url}`,
                        responseStatus: response.status,
                        responseTotalResults: response.data?.totalResults,
                        responseFirstProjectId: response.data?.results?.[0]?.id,
                        responseFirstProjectStatus: response.data?.results?.[0]?.job?.status
                    }, null, 2)
                );
                logger.info(`[🤖 SpeechLab] 📝 Wrote API response summary (Attempt ${attempt}) to ${tempFilePath}`);
            } catch (writeError) {
                logger.error(`[🤖 SpeechLab] ❌ Failed to write API response summary to file (Attempt ${attempt}):`, writeError);
            }

            if (response.data?.results && response.data.results.length > 0) {
                const project = response.data.results[0]; 
                const status = project.job?.status || "UNKNOWN";
                
                logger.info(`[🤖 SpeechLab] ✅ (Attempt ${attempt}) Found project with ID: ${project.id} for thirdPartyID: ${thirdPartyID}`);
                logger.info(`[🤖 SpeechLab] 📊 (Attempt ${attempt}) Project status: ${status}`);
                logger.info(`[🤖 SpeechLab] 📋 (Attempt ${attempt}) Project details: Name: \\\"${project.job?.name || 'Unknown'}\\\", Source: ${project.job?.sourceLanguage || 'Unknown'}, Target: ${project.job?.targetLanguage || 'Unknown'}`);
                logger.debug(`[🤖 SpeechLab] 🔍 (Attempt ${attempt}) Found ${project.translations?.[0]?.dub?.[0]?.medias?.length || 0} media objects in first translation's first dub.`); 
                logger.debug(`[🤖 SpeechLab] --- FULL PROJECT RESPONSE (Attempt ${attempt}) ---`);
                logger.debug(JSON.stringify(response.data, null, 2));
                logger.debug(`[🤖 SpeechLab] --- END FULL PROJECT RESPONSE (Attempt ${attempt}) ---`);

                return project; // Success! Return the project details
            } else {
                logger.warn(`[🤖 SpeechLab] ⚠️ (Attempt ${attempt}) No projects found matching thirdPartyID: ${thirdPartyID}`);
                if (response.data?.totalResults !== undefined) {
                    logger.warn(`[🤖 SpeechLab] API reported ${response.data.totalResults} total results for this query (Attempt ${attempt}).`);
                }
                return null; // No project found, but API call succeeded
            }

        } catch (error) {
            const context = `getting project status for thirdPartyID: ${thirdPartyID} (Attempt ${attempt})`;

            if (axios.isAxiosError(error) && error.response?.status === 401 && attempt < maxAttempts) {
                logger.warn(`[🤖 SpeechLab] ⚠️ Received 401 Unauthorized on attempt ${attempt} for project status check. Invalidating token and retrying...`);
                invalidateAuthToken();
                attempt++;
                logger.debug(`[🤖 SpeechLab] 🔍 Fetching project status from API URL (Attempt ${attempt}): ${API_BASE_URL}${url}`); // Log URL for retry
                continue; 
            } else {
                handleApiError(error, context);
                return null;
            }
        }
    }
    
    logger.error(`[🤖 SpeechLab] ❌ Failed to get project status for ${thirdPartyID} after ${maxAttempts} attempts.`);
    return null;
}

/**
 * Waits for a project to reach COMPLETE status, checking at regular intervals.
 * @param thirdPartyID The thirdPartyID of the project to monitor
 * @param maxWaitTimeMs Maximum time to wait in milliseconds (default: 1 hour)
 * @param checkIntervalMs Interval between status checks in milliseconds (default: 30 seconds)
 * @returns {Promise<Project | null>} The full project object if completed successfully, otherwise null
 */
export async function waitForProjectCompletion(
    thirdPartyID: string, 
    maxWaitTimeMs = 60 * 60 * 1000, // 1 hour default
    checkIntervalMs = 30000 // 30 seconds default
): Promise<Project | null> {
    logger.info(`[🤖 SpeechLab] Waiting for project completion: ${thirdPartyID}`);
    logger.info(`[🤖 SpeechLab] Maximum wait time: ${maxWaitTimeMs/1000/60} minutes, Check interval: ${checkIntervalMs/1000} seconds`);
    
    const startTime = Date.now();
    let pollCount = 0;
    let lastProjectDetails: Project | null = null; // Store last retrieved details
    
    while (Date.now() - startTime < maxWaitTimeMs) {
        pollCount++;
        const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
        
        logger.info(`[🤖 SpeechLab] 🔄 Poll #${pollCount} - Checking project status (${elapsedSeconds}s elapsed)...`);
        
        // Get the full project details
        const project = await getProjectByThirdPartyID(thirdPartyID); 
        lastProjectDetails = project; // Store the latest result
        
        if (!project) {
            logger.warn(`[🤖 SpeechLab] ⚠️ Poll #${pollCount} - Could not retrieve project details, will retry in ${checkIntervalMs/1000}s...`);
        } else if (project.job?.status === "COMPLETE") {
            const elapsedMinutes = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
            logger.info(`[🤖 SpeechLab] ✅ Poll #${pollCount} - Project completed successfully after ${elapsedMinutes} minutes!`);
            return project; // Return the full project object on success
        } else if (project.job?.status === "FAILED") {
            logger.error(`[🤖 SpeechLab] ❌ Poll #${pollCount} - Project failed to process!`);
            return null; // Return null on failure
        } else {
            // Calculate progress (simplified)
            const status = project.job?.status || "UNKNOWN";
            const progressPercent = status === "PROCESSING" ? 50 : 0; 
            let remainingTimeEstimate = "unknown";
            
            if (progressPercent > 0) {
                const elapsedMs = Date.now() - startTime;
                const estimatedTotalMs = (elapsedMs / progressPercent) * 100;
                const estimatedRemainingMs = estimatedTotalMs - elapsedMs;
                const estimatedRemainingMin = Math.ceil(estimatedRemainingMs / 1000 / 60);
                remainingTimeEstimate = `~${estimatedRemainingMin} minutes`;
            }
            
            logger.info(`[🤖 SpeechLab] 🕒 Poll #${pollCount} - Project status: ${status}, Progress: ${progressPercent}%, Estimated time remaining: ${remainingTimeEstimate}`);
            logger.info(`[🤖 SpeechLab] ⏳ Poll #${pollCount} - Will check again in ${checkIntervalMs/1000}s...`);
        }
        
        logger.debug(`[🤖 SpeechLab] 💤 Poll #${pollCount} - Sleeping for ${checkIntervalMs/1000}s before next check...`);
        await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
    }
    
    const maxWaitMinutes = (maxWaitTimeMs/1000/60).toFixed(1);
    logger.warn(`[🤖 SpeechLab] ⏰ Poll #${pollCount} - Maximum wait time of ${maxWaitMinutes} minutes exceeded without project completion.`);
    return lastProjectDetails?.job?.status === "COMPLETE" ? lastProjectDetails : null; // Return last details only if complete, else null
}

interface CreateDubbingProjectResponse {
    id: string;
    // ... other properties
}

interface ProjectStatusResponse {
    id: string;
    thirdPartyID?: string;
    job?: {
        status: string; // e.g., QUEUED, PROCESSING, COMPLETE, FAILED
        // ... other job properties
    };
    translations?: {
        dub?: {
            medias?: { category: string; format: string; operationType: string, presignedURL: string }[];
        }[];
    }[];
    // ---- ADDED FOR TRANSCRIPTION ----
    transcription?: {
        transcriptionText?: string;
        // ... other transcription properties
    };
    // ---- END ADDED ----
}

// --- Interface for createProjectAndTranscribe API ---
export interface CreateProjectAndTranscribePayload {
    fileUuid: string;
    fileKey: string; // S3 key
    name: string; // Project name
    filenameToReturn: string; // e.g., original_filename.mp3
    language: string; // source language code e.g., "en"
    contentDuration: number; // in seconds
    thumbnail?: string; // base64 encoded image, optional
    unitType: 'whiteGlove'; // As per cURL
    thirdPartyID: string; // For tracking
    collectionRef: string; // As per cURL, from config
}

export interface CreateProjectAndTranscribeResponse {
    id: string; // SpeechLab project ID
    // ... any other relevant fields from the API response
}

/**
 * Creates a new transcription project with SpeechLab API.
 * @param payload - The data for creating the transcription project.
 * @returns The SpeechLab project ID if successful, otherwise null.
 */
export async function createProjectAndTranscribe(
    payload: CreateProjectAndTranscribePayload
): Promise<string | null> {
    const authToken = await getAuthToken();
    if (!authToken) {
        logger.error('[SpeechLab API] Failed to get auth token for createProjectAndTranscribe.');
        return null;
    }

    const apiUrl = `${API_BASE_URL}/projects/createProjectAndTranscribe`;
    logger.info(`[SpeechLab API] Calling createProjectAndTranscribe for thirdPartyID: ${payload.thirdPartyID}`);
    logger.debug(`[SpeechLab API] CreateProjectAndTranscribe payload: ${JSON.stringify(payload)}`);

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`,
                'Accept': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            logger.error(`[SpeechLab API] Error creating transcription project: ${response.status} ${response.statusText} - ${errorBody}`);
            return null;
        }

        const result: CreateProjectAndTranscribeResponse = await response.json();
        logger.info(`[SpeechLab API] Successfully created transcription project. Project ID: ${result.id}, ThirdPartyID: ${payload.thirdPartyID}`);
        return result.id;
    } catch (error) {
        logger.error('[SpeechLab API] Exception during createProjectAndTranscribe:', error);
        return null;
    }
}

/**
 * Waits for a SpeechLab transcription project to complete.
 * Polls the project status using thirdPartyID.
 * @param thirdPartyID The third-party ID of the project.
 * @param timeoutMs Maximum time to wait in milliseconds.
 * @returns The completed project data including transcriptionText, or null if timeout or error.
 */
export async function waitForTranscriptionCompletion(
    thirdPartyID: string,
    timeoutMs: number = 30 * 60 * 1000 // Default 30 minutes timeout
): Promise<Project | null> {
    const pollIntervalMs = 30 * 1000; // Poll every 30 seconds
    const startTime = Date.now();

    logger.info(`[SpeechLab API] Waiting for transcription project completion (thirdPartyID: ${thirdPartyID}). Timeout: ${timeoutMs / 60000}m`);

    while (Date.now() - startTime < timeoutMs) {
        try {
            const project = await getProjectByThirdPartyID(thirdPartyID);

            if (project) {
                logger.debug(`[SpeechLab API] Polling transcription status for ${thirdPartyID}: ${project.job?.status}`);
                if (project.job?.status === 'COMPLETE') {
                    if (project.transcription?.transcriptionText) {
                        logger.info(`[SpeechLab API] Transcription project ${thirdPartyID} COMPLETED successfully with transcription text.`);
                        return project;
                    } else {
                        logger.warn(`[SpeechLab API] Transcription project ${thirdPartyID} COMPLETED but no transcriptionText found.`);
                        // Treat as failure for summarization if text is missing
                        return { ...project, job: { ...(project.job || {}), status: 'FAILED_NO_TEXT' } } as Project;
                    }
                } else if (project.job?.status === 'FAILED') {
                    logger.error(`[SpeechLab API] Transcription project ${thirdPartyID} FAILED.`);
                    return project; // Return the failed project details
                }
                // Continue polling for QUEUED, PROCESSING, or other statuses
            } else {
                logger.warn(`[SpeechLab API] Could not retrieve project status for thirdPartyID: ${thirdPartyID} during polling.`);
                // Optionally, could implement a retry limit for consecutive null responses
            }
        } catch (error) {
            logger.error(`[SpeechLab API] Error polling transcription project status for ${thirdPartyID}:`, error);
            // Depending on error, might break or continue polling
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    logger.error(`[SpeechLab API] Timeout waiting for transcription project ${thirdPartyID} to complete.`);
    return null;
} 