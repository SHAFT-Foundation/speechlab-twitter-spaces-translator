import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../utils/config';
import logger from '../utils/logger';
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';

const API_BASE_URL = 'https://translate-api.speechlab.ai';

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
 * Creates a dubbing project in SpeechLab.
 * @param publicAudioUrl The publicly accessible URL of the source audio file (e.g., S3 URL).
 * @param projectName The desired name for the project.
 * @param targetLanguageCode The detected target language code (e.g., 'es').
 * @param thirdPartyId The unique identifier for this job (e.g., spaceId-langCode).
 * @returns {Promise<string | null>} The projectId if successful, otherwise null.
 */
export async function createDubbingProject(
    publicAudioUrl: string, 
    projectName: string, 
    targetLanguageCode: string, 
    thirdPartyId: string 
): Promise<string | null> {
    logger.info(`[🤖 SpeechLab] Attempting to create dubbing project: Name="${projectName}", Lang=${targetLanguageCode}, 3rdPartyID=${thirdPartyId}`);
    const token = await getAuthToken();
    if (!token) {
        logger.error('[🤖 SpeechLab] ❌ Cannot create project: Failed to get authentication token.');
        return null;
    }

    // Ensure projectName is reasonably limited
    const finalProjectName = projectName.substring(0, 100);

    const payload: CreateDubPayload = {
        name: finalProjectName,
        sourceLanguage: config.SOURCE_LANGUAGE, 
        targetLanguage: targetLanguageCode,     
        dubAccent: targetLanguageCode,          
        unitType: "whiteGlove",
        mediaFileURI: publicAudioUrl,
        voiceMatchingMode: "source", 
        thirdPartyID: thirdPartyId,       // Use the ID passed directly into the function
    };

    logger.debug(`[🤖 SpeechLab] Create project payload: ${JSON.stringify(payload)}`);

    try {
        const response = await apiClient.post<CreateDubResponse>('/v1/projects/createProjectAndDub', payload, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const projectId = response.data?.projectId;
        if (projectId) {
            logger.info(`[🤖 SpeechLab] ✅ Successfully created project. Project ID: ${projectId} (ThirdPartyID: ${thirdPartyId})`);
            return projectId;
        } else {
            logger.error(`[🤖 SpeechLab] ❌ Project creation API call successful but projectId not found in response.`);
             logger.debug(`[🤖 SpeechLab] Full create project response: ${JSON.stringify(response.data)}`);
            return null;
        }

    } catch (error) {
        handleApiError(error, `project creation for ${finalProjectName} (3rdPartyID: ${thirdPartyId})`);
        return null;
    }
}

/**
 * Generates a sharing link for a given SpeechLab project.
 * @param projectId The ID of the project.
 * @returns {Promise<string | null>} The sharing link URL if successful, otherwise null.
 */
export async function generateSharingLink(projectId: string): Promise<string | null> {
    logger.info(`[🤖 SpeechLab] Attempting to generate sharing link for project ID: ${projectId}`);
    const token = await getAuthToken();
    if (!token) {
        logger.error('[🤖 SpeechLab] ❌ Cannot generate link: Failed to get authentication token.');
        return null;
    }

    const payload: GenerateLinkPayload = { projectId };
     logger.debug(`[🤖 SpeechLab] Generate link payload: ${JSON.stringify(payload)}`);

    try {
        const response = await apiClient.post<GenerateLinkResponse>('/v1/collaborations/generateSharingLink', payload, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const link = response.data?.link;
        if (link) {
            logger.info(`[🤖 SpeechLab] ✅ Successfully generated sharing link: ${link}`);
            return link;
        } else {
            logger.error('[🤖 SpeechLab] ❌ Link generation successful but link not found in response.');
            logger.debug(`[🤖 SpeechLab] Full generate link response: ${JSON.stringify(response.data)}`);
            return null;
        }
    } catch (error) {
        handleApiError(error, `sharing link generation for project ${projectId}`);
        return null;
    }
}

/**
 * Gets project details by thirdPartyID to check its status.
 * Returns the *full* project object if found.
 * @param thirdPartyID The thirdPartyID used when creating the project
 * @returns {Promise<Project | null>} Full project object if found, otherwise null
 */
export async function getProjectByThirdPartyID(thirdPartyID: string): Promise<Project | null> {
    logger.info(`[🤖 SpeechLab] Getting project status for thirdPartyID: ${thirdPartyID}`);
    const token = await getAuthToken();
    if (!token) {
        logger.error('[🤖 SpeechLab] ❌ Cannot check project status: Failed to get authentication token.');
        return null;
    }

    try {
        const encodedThirdPartyID = encodeURIComponent(thirdPartyID);
        const url = `/v1/projects?sortBy=createdAt%3Aasc&limit=10&page=1&expand=true&thirdPartyIDs=${encodedThirdPartyID}`;
        
        logger.debug(`[🤖 SpeechLab] 🔍 Fetching project status from API URL: ${API_BASE_URL}${url}`);
        
        const response = await apiClient.get<GetProjectsResponse>(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        // Write the *summary* API response to a temporary file for debugging if needed
        const tempFilePath = path.join(process.cwd(), 'temp_api_response_summary.json');
        try {
            fsPromises.writeFile(
                tempFilePath,
                JSON.stringify({
                    timestamp: new Date().toISOString(),
                    thirdPartyID: thirdPartyID,
                    requestUrl: `${API_BASE_URL}${url}`,
                    responseStatus: response.status,
                    responseTotalResults: response.data?.totalResults,
                    responseFirstProjectId: response.data?.results?.[0]?.id,
                    responseFirstProjectStatus: response.data?.results?.[0]?.job?.status
                }, null, 2)
            );
            logger.info(`[🤖 SpeechLab] 📝 Wrote API response summary to ${tempFilePath}`);
        } catch (writeError) {
            logger.error(`[🤖 SpeechLab] ❌ Failed to write API response summary to file:`, writeError);
        }

        if (response.data?.results && response.data.results.length > 0) {
            const project = response.data.results[0]; 
            const status = project.job?.status || "UNKNOWN";
            
            logger.info(`[🤖 SpeechLab] ✅ Found project with ID: ${project.id} for thirdPartyID: ${thirdPartyID}`);
            logger.info(`[🤖 SpeechLab] 📊 Project status: ${status}`);
            logger.info(`[🤖 SpeechLab] 📋 Project details: Name: \"${project.job?.name || 'Unknown'}\", Source: ${project.job?.sourceLanguage || 'Unknown'}, Target: ${project.job?.targetLanguage || 'Unknown'}`);
            // Corrected debug log path for the *medias* array inside the first dub object of the first translation
            logger.debug(`[🤖 SpeechLab] 🔍 Found ${project.translations?.[0]?.dub?.[0]?.medias?.length || 0} media objects in first translation's first dub.`); 
            // Log the full response data for debugging
            logger.debug(`[🤖 SpeechLab] --- FULL PROJECT RESPONSE ---`);
            logger.debug(JSON.stringify(response.data, null, 2));
            logger.debug(`[🤖 SpeechLab] --- END FULL PROJECT RESPONSE ---`);

            // Return the full project object
            return project;
        } else {
            logger.warn(`[🤖 SpeechLab] ⚠️ No projects found matching thirdPartyID: ${thirdPartyID}`);
            if (response.data?.totalResults !== undefined) {
                logger.warn(`[🤖 SpeechLab] API reported ${response.data.totalResults} total results for this query.`);
            }
            return null;
        }
    } catch (error) {
        handleApiError(error, `getting project status for thirdPartyID: ${thirdPartyID}`);
        return null;
    }
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