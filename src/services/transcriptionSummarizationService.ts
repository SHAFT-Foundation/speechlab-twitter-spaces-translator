import logger from '../utils/logger';
import { createTranscriptionProject, waitForTranscriptionCompletion } from './speechlabApiService';
import { summarizeTwitterSpace } from './openaiService';
import { v4 as uuidv4 } from 'uuid';

/**
 * Interface for the transcription and summarization request
 */
export interface TranscriptionRequest {
    fileUuid: string;
    fileKey: string;
    name: string;
    filenameToReturn: string;
    language: string;
    contentDuration: number;
    thumbnail?: string;
}

/**
 * Interface for the transcription and summarization result
 */
export interface TranscriptionSummaryResult {
    success: boolean;
    projectId?: string;
    transcriptionText?: string;
    summary?: string;
    errorMessage?: string;
}

/**
 * Main function that orchestrates the transcription and summarization workflow
 * @param request The transcription request parameters
 * @returns {Promise<TranscriptionSummaryResult>} The result containing transcription and summary
 */
export async function transcribeAndSummarize(request: TranscriptionRequest): Promise<TranscriptionSummaryResult> {
    logger.info(`[🎯 Transcription] Starting transcription and summarization workflow for: ${request.name}`);
    
    try {
        // Step 1: Create transcription project
        logger.info('[🎯 Transcription] Step 1: Creating transcription project...');
        const projectId = await createTranscriptionProject(
            request.fileUuid,
            request.fileKey,
            request.name,
            request.filenameToReturn,
            request.language,
            request.contentDuration,
            request.thumbnail
        );

        if (!projectId) {
            const errorMessage = 'Failed to create transcription project';
            logger.error(`[🎯 Transcription] ❌ ${errorMessage}`);
            return {
                success: false,
                errorMessage
            };
        }

        logger.info(`[🎯 Transcription] ✅ Step 1 completed: Project created with ID ${projectId}`);

        // Step 2: Wait for transcription completion
        logger.info('[🎯 Transcription] Step 2: Waiting for transcription completion...');
        const completedProject = await waitForTranscriptionCompletion(projectId);

        if (!completedProject || !completedProject.transcription?.transcriptionText) {
            const errorMessage = 'Transcription project failed or no transcription text available';
            logger.error(`[🎯 Transcription] ❌ ${errorMessage}`);
            return {
                success: false,
                projectId,
                errorMessage
            };
        }

        const transcriptionText = completedProject.transcription.transcriptionText;
        logger.info(`[🎯 Transcription] ✅ Step 2 completed: Transcription received (${transcriptionText.length} characters)`);

        // Step 3: Summarize the transcription using OpenAI
        logger.info('[🎯 Transcription] Step 3: Generating summary using OpenAI...');
        const summary = await summarizeTwitterSpace(transcriptionText);

        if (!summary) {
            const errorMessage = 'Failed to generate summary using OpenAI';
            logger.error(`[🎯 Transcription] ❌ ${errorMessage}`);
            return {
                success: false,
                projectId,
                transcriptionText,
                errorMessage
            };
        }

        logger.info(`[🎯 Transcription] ✅ Step 3 completed: Summary generated (${summary.length} characters)`);
        logger.info('[🎯 Transcription] 🎉 Workflow completed successfully!');

        return {
            success: true,
            projectId,
            transcriptionText,
            summary
        };

    } catch (error) {
        const errorMessage = `Unexpected error during transcription and summarization workflow: ${error instanceof Error ? error.message : 'Unknown error'}`;
        logger.error(`[🎯 Transcription] ❌ ${errorMessage}`, error);
        
        return {
            success: false,
            errorMessage
        };
    }
}

/**
 * Helper function to create a transcription request from the curl example data
 * @param curlData The data from the curl example
 * @returns {TranscriptionRequest} The formatted transcription request
 */
export function createTranscriptionRequestFromCurl(curlData: any): TranscriptionRequest {
    return {
        fileUuid: curlData.fileUuid || uuidv4(),
        fileKey: curlData.fileKey || `original/${curlData.fileUuid || uuidv4()}.mov`,
        name: curlData.name || 'Twitter Space Transcription',
        filenameToReturn: curlData.filenameToReturn || `${curlData.name || 'transcription'}.mov`,
        language: curlData.language || 'en',
        contentDuration: curlData.contentDuration || 0,
        thumbnail: curlData.thumbnail
    };
}

/**
 * Example function showing how to use the transcription and summarization workflow
 * This matches the curl example provided by the user
 */
export async function exampleTranscriptionWorkflow(): Promise<void> {
    logger.info('[🎯 Example] Running example transcription and summarization workflow...');
    
    // Example data based on the user's curl request
    const exampleRequest: TranscriptionRequest = {
        fileUuid: "48f4d943-9928-47bf-8497-d92b3ef1c111",
        fileKey: "original/48f4d943-9928-47bf-8497-d92b3ef1c111.mov",
        name: "ryantest copy 27",
        filenameToReturn: "ryantest copy 27.mov",
        language: "en",
        contentDuration: 17.521938,
        thumbnail: "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"
    };

    const result = await transcribeAndSummarize(exampleRequest);
    
    if (result.success) {
        logger.info('[🎯 Example] ✅ Workflow completed successfully!');
        logger.info(`[🎯 Example] Project ID: ${result.projectId}`);
        logger.info(`[🎯 Example] Transcription length: ${result.transcriptionText?.length} characters`);
        logger.info(`[🎯 Example] Summary length: ${result.summary?.length} characters`);
        logger.info(`[🎯 Example] Summary: ${result.summary}`);
    } else {
        logger.error(`[🎯 Example] ❌ Workflow failed: ${result.errorMessage}`);
    }
}