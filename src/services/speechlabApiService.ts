import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../utils/config';
import logger from '../utils/logger';

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
 * @param spaceName The name to use for the project and thirdPartyID.
 * @returns {Promise<string | null>} The projectId if successful, otherwise null.
 */
export async function createDubbingProject(publicAudioUrl: string, spaceName: string): Promise<string | null> {
    logger.info(`[🤖 SpeechLab] Attempting to create dubbing project for: ${spaceName}`);
    const token = await getAuthToken();
    if (!token) {
        logger.error('[🤖 SpeechLab] ❌ Cannot create project: Failed to get authentication token.');
        return null;
    }

    // Sanitize spaceName or use a default for API fields
    const projectName = spaceName ? spaceName.substring(0, 100) : `Dubbed Space ${new Date().toISOString()}`; // Ensure reasonable length
    const thirdPartyId = spaceName ? spaceName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50) : `id_${Date.now()}`; // Ensure valid characters/length

    const payload: CreateDubPayload = {
        name: projectName,
        sourceLanguage: config.SOURCE_LANGUAGE,
        targetLanguage: config.TARGET_LANGUAGE,
        dubAccent: config.DUB_ACCENT,
        unitType: "whiteGlove",
        mediaFileURI: publicAudioUrl,
        voiceMatchingMode: "source",
        thirdPartyID: thirdPartyId,
        // customizedVoiceMatchingSpeakers: [], // Keep empty as per spec
    };

    logger.debug(`[🤖 SpeechLab] Create project payload: ${JSON.stringify(payload)}`);

    try {
        const response = await apiClient.post<CreateDubResponse>('/v1/projects/createProjectAndDub', payload, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const projectId = response.data?.projectId;
        if (projectId) {
            logger.info(`[🤖 SpeechLab] ✅ Successfully created project. Project ID: ${projectId}`);
            return projectId;
        } else {
            logger.error('[🤖 SpeechLab] ❌ Project creation successful but projectId not found in response.');
             logger.debug(`[🤖 SpeechLab] Full create project response: ${JSON.stringify(response.data)}`);
            return null;
        }

    } catch (error) {
        handleApiError(error, `project creation for ${projectName}`);
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