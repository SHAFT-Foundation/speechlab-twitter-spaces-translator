# Transcription and Summarization Feature

This document describes the new transcription and summarization functionality that has been added to the SpeechLab Twitter Spaces Translator.

## Overview

The new feature allows you to:
1. Create transcription projects using SpeechLab's `createProjectAndTranscribe` API
2. Poll the project status until transcription is complete
3. Extract the transcription text from the completed project
4. Use OpenAI GPT to generate a detailed summary of the Twitter Space content

## Architecture

### Services Added

1. **`openaiService.ts`** - Handles OpenAI API integration for summarization
2. **`transcriptionSummarizationService.ts`** - Orchestrates the complete workflow
3. **Enhanced `speechlabApiService.ts`** - Added transcription-specific functions

### Configuration Changes

Added `OPENAI_API_KEY` to the required environment variables in `config.ts`.

## API Endpoints Used

### SpeechLab Transcription API
- **Endpoint**: `https://api-translate-dev.speechlab.ai/v1/projects/createProjectAndTranscribe`
- **Method**: POST
- **Purpose**: Creates a transcription project

### SpeechLab Project Status API
- **Endpoint**: `https://api-translate-dev.speechlab.ai/v1/projects/{projectId}?expand=true`
- **Method**: GET
- **Purpose**: Retrieves project details and transcription text

### OpenAI Chat Completions API
- **Model**: `gpt-4o-mini`
- **Purpose**: Generates detailed summaries of Twitter Space content

## Usage

### Basic Usage

```typescript
import { transcribeAndSummarize, TranscriptionRequest } from './services/transcriptionSummarizationService';

const request: TranscriptionRequest = {
    fileUuid: "48f4d943-9928-47bf-8497-d92b3ef1c111",
    fileKey: "original/48f4d943-9928-47bf-8497-d92b3ef1c111.mov",
    name: "Twitter Space Transcription",
    filenameToReturn: "transcription.mov",
    language: "en",
    contentDuration: 17.521938,
    thumbnail: "base64_encoded_thumbnail" // optional
};

const result = await transcribeAndSummarize(request);

if (result.success) {
    console.log('Project ID:', result.projectId);
    console.log('Transcription:', result.transcriptionText);
    console.log('Summary:', result.summary);
} else {
    console.error('Error:', result.errorMessage);
}
```

### Running the Test

```bash
npm run test:transcription
```

This will run the example workflow using the data from the curl request provided by the user.

## Environment Variables

Make sure to add the following to your `.env` file:

```env
OPENAI_API_KEY=your_openai_api_key_here
```

## Workflow Steps

1. **Create Transcription Project**
   - Calls SpeechLab's `createProjectAndTranscribe` endpoint
   - Returns a project ID for tracking

2. **Poll for Completion**
   - Checks project status every 30 seconds (configurable)
   - Waits up to 30 minutes for completion (configurable)
   - Extracts transcription text when complete

3. **Generate Summary**
   - Sends transcription text to OpenAI GPT-4o-mini
   - Uses a specialized prompt for Twitter Space summarization
   - Returns a detailed summary excluding speaker names

## Error Handling

The service includes comprehensive error handling:
- Authentication token refresh on 401 errors
- Retry logic for API calls
- Detailed logging with emoji prefixes for easy identification
- Graceful handling of missing transcription text

## Logging

All operations are logged with distinctive prefixes:
- `[🤖 SpeechLab]` - SpeechLab API operations
- `[🤖 OpenAI]` - OpenAI API operations  
- `[🎯 Transcription]` - Main workflow operations
- `[🧪 Test]` - Test script operations

## Integration with Mention Monitoring

This functionality can be easily integrated into the existing mention monitoring daemon to automatically transcribe and summarize Twitter Spaces when users mention the bot with a Space URL.

## Example Response Structure

```typescript
interface TranscriptionSummaryResult {
    success: boolean;
    projectId?: string;
    transcriptionText?: string;
    summary?: string;
    errorMessage?: string;
}
```

## Performance Considerations

- Transcription typically takes 2-10 minutes depending on audio length
- OpenAI summarization is usually completed in 10-30 seconds
- The service uses efficient polling with configurable intervals
- Authentication tokens are cached to reduce API calls

## Future Enhancements

Potential improvements could include:
- Support for multiple languages in summarization
- Custom summary templates for different types of content
- Integration with the existing dubbing workflow
- Webhook support for real-time notifications