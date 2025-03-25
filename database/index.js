// database/index.js
const mongoose = require('mongoose');
require('dotenv').config();

// MongoDB connection string from environment variables
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/discord-transcriptions';

// Connection options
const options = {
  useNewUrlParser: true,
  useUnifiedTopology: true
};

// Connection state tracking
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 5000; // 5 seconds

// Connect to MongoDB with retry logic
async function initDatabaseConnection() {
  // Prevent multiple simultaneous connection attempts
  if (isConnecting) {
    console.log('Connection attempt already in progress...');
    return false;
  }
  
  isConnecting = true;
  
  try {
    console.log(`Attempting to connect to MongoDB at ${MONGODB_URI}...`);
    await mongoose.connect(MONGODB_URI, options);
    console.log('✅ Successfully connected to MongoDB database');
    reconnectAttempts = 0;
    isConnecting = false;
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    isConnecting = false;
    return false;
  }
}

// Attempt reconnection with exponential backoff
function attemptReconnection() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`Exceeded maximum reconnection attempts (${MAX_RECONNECT_ATTEMPTS}). Please check your database configuration.`);
    console.log('The bot will continue to run without database functionality.');
    return;
  }
  
  reconnectAttempts++;
  
  // Calculate delay with exponential backoff
  const delay = RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
  
  console.log(`Will attempt to reconnect in ${delay/1000} seconds (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  
  setTimeout(() => {
    console.log('Attempting reconnection to MongoDB...');
    initDatabaseConnection();
  }, delay);
}

// Handle connection events
mongoose.connection.on('error', err => {
  console.error('MongoDB connection error event:', err.message);
  // Don't attempt to reconnect here - let the disconnect handler handle it
});

mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB disconnected event triggered.');
  
  // Only attempt reconnection if we're not already connecting
  // and we're not shutting down the application
  if (!isConnecting && process.env.NODE_ENV !== 'shutdown') {
    attemptReconnection();
  }
});

mongoose.connection.on('connected', () => {
  console.log('MongoDB connected event fired.');
  reconnectAttempts = 0;
});

// Handle application shutdown
process.on('SIGINT', async () => {
  // Mark that we're shutting down to prevent reconnection attempts
  process.env.NODE_ENV = 'shutdown';
  
  console.log('Application shutdown detected. Closing MongoDB connection...');
  
  try {
    await mongoose.connection.close();
    console.log('MongoDB connection closed gracefully.');
  } catch (err) {
    console.error('Error while closing MongoDB connection:', err);
  }
  
  process.exit(0);
});

// Export the connection function and mongoose instance
module.exports = {
  connectDatabase: initDatabaseConnection,
  mongoose
};