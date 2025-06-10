# Transcription and Summarization Feature

> **Note:** As of June 2025, all transcription and summarization requests use the SpeechLab `createProjectAndDub` API. The `createProjectAndTranscribe` API and all related functions are deprecated and must not be used. The dubbing API is used for both dubbing and transcript summary requests.

This document describes the transcription and summarization functionality for the SpeechLab Twitter Spaces Translator.

## Overview

The feature allows you to:
1. Create projects using SpeechLab's `createProjectAndDub` API (for both dubbing and transcript summary)
2. Poll the project status until processing is complete
3. Extract the transcription text from the completed dubbing project
4. Use OpenAI GPT to generate a detailed summary of the Twitter Space content

## Architecture

### Services Used

1. **`openaiService.ts`** - Handles OpenAI API integration for summarization
2. **`transcriptionSummarizationService.ts`** - Orchestrates the complete workflow
3. **`speechlabApiService.ts`** - Handles all SpeechLab API calls (dubbing and transcript summary)

### Configuration Changes

Added `OPENAI_API_KEY` to the required environment variables in `config.ts`.

## API Endpoints Used

### SpeechLab Dubbing API
- **Endpoint**: `https://translate-api.speechlab.ai/v1/projects/createProjectAndDub`
- **Method**: POST
- **Purpose**: Creates a dubbing project (used for both dubbing and transcript summary)

### SpeechLab Project Status API
- **Endpoint**: `https://translate-api.speechlab.ai/v1/projects/{projectId}?expand=true`
- **Method**: GET
- **Purpose**: Retrieves project details and transcription text (from the dubbing project)

### OpenAI Chat Completions API
- **Model**: `gpt-4o-mini`
- **Purpose**: Generates detailed summaries of Twitter Space content

## Usage

### Basic Usage

```typescript
// Use the dubbing API for all requests
import { createDubbingProject, getProjectByThirdPartyID, getProjectTranscription } from './services/speechlabApiService';
import { summarizeTwitterSpace } from './openaiService';

// ...
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
   - Calls SpeechLab's `createProjectAndDub` endpoint
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