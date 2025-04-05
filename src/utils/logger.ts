import winston from 'winston';
import { config } from './config'; // Import config to get LOG_LEVEL

// Define log format
const logFormat = winston.format.printf(({ level, message, timestamp, stack }) => {
    // Add icons based on level for clarity
    let icon = 'ℹ️'; // Default info
    if (level === 'error') icon = '❌';
    else if (level === 'warn') icon = '⚠️';
    else if (level === 'debug') icon = '🐛';
    else if (level === 'verbose') icon = '📢';
    // Check if message is a string before calling includes
    else if (typeof message === 'string' && (message.includes('✅') || message.includes('successfully'))) {
        icon = '✅'; // Allow explicit success icon
    }

    // Include stack trace for errors
    // Ensure message is stringified if it's not already (e.g., an object)
    const logMessage = stack ? `${stack}` : (typeof message === 'string' ? message : JSON.stringify(message));

    return `${icon} [${timestamp}] [${level.toUpperCase()}]: ${logMessage}`;
});

// Create logger instance
const logger = winston.createLogger({
    level: config.LOG_LEVEL || 'info', // Use level from config, default to info
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }), // Log stack trace for errors
        winston.format.splat(),
        logFormat // Use the custom format
    ),
    transports: [
        new winston.transports.Console(),
        // Optionally add file transport
        // new winston.transports.File({ filename: 'error.log', level: 'error' }),
        // new winston.transports.File({ filename: 'combined.log' })
    ],
    exitOnError: false, // Do not exit on handled exceptions
});

logger.info(`Logger initialized with level: ${logger.level}`);

export default logger; 