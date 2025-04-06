"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var winston_1 = require("winston");
var config_1 = require("./config"); // Import config to get LOG_LEVEL
// Define log format
var logFormat = winston_1.default.format.printf(function (_a) {
    var level = _a.level, message = _a.message, timestamp = _a.timestamp, stack = _a.stack;
    // Add icons based on level for clarity
    var icon = 'ℹ️'; // Default info
    if (level === 'error')
        icon = '❌';
    else if (level === 'warn')
        icon = '⚠️';
    else if (level === 'debug')
        icon = '🐛';
    else if (level === 'verbose')
        icon = '📢';
    // Check if message is a string before calling includes
    else if (typeof message === 'string' && (message.includes('✅') || message.includes('successfully'))) {
        icon = '✅'; // Allow explicit success icon
    }
    // Include stack trace for errors
    // Ensure message is stringified if it's not already (e.g., an object)
    var logMessage = stack ? "".concat(stack) : (typeof message === 'string' ? message : JSON.stringify(message));
    return "".concat(icon, " [").concat(timestamp, "] [").concat(level.toUpperCase(), "]: ").concat(logMessage);
});
// Create logger instance
var logger = winston_1.default.createLogger({
    level: config_1.config.LOG_LEVEL || 'info', // Use level from config, default to info
    format: winston_1.default.format.combine(winston_1.default.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), winston_1.default.format.errors({ stack: true }), // Log stack trace for errors
    winston_1.default.format.splat(), logFormat // Use the custom format
    ),
    transports: [
        new winston_1.default.transports.Console(),
        // Optionally add file transport
        // new winston.transports.File({ filename: 'error.log', level: 'error' }),
        // new winston.transports.File({ filename: 'combined.log' })
    ],
    exitOnError: false, // Do not exit on handled exceptions
});
logger.info("Logger initialized with level: ".concat(logger.level));
exports.default = logger;
