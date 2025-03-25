// Modified version of transcriptionService.js with detailed logging

// services/transcriptionService.js
const axios = require('axios');
const fs = require('fs');
const User = require('../models/User');

// Add the debug logging function
function debugLog(area, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${area}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

class TranscriptionService {
  constructor() {
    this.apiUrl = 'https://api.openai.com/v1/audio/transcriptions';
    this.apiKey = process.env.OPENAI_API_KEY;
    debugLog('SERVICE', 'TranscriptionService initialized with API key');
  }

  /**
   * Transcribe audio file and save to database
   */
  async transcribeAndSave(audioFilePath, userData, contextData, startTime) {
    debugLog('SERVICE', `transcribeAndSave called for user ${userData.username}`, {
      audioPath: audioFilePath,
      userData: userData,
      contextData: contextData
    });
    
    try {
      // 1. Check if file exists
      if (!fs.existsSync(audioFilePath)) {
        debugLog('ERROR', `Audio file not found: ${audioFilePath}`);
        return null;
      }
      
      debugLog('SERVICE', `Audio file exists: ${audioFilePath}`);
      
      // 2. Get audio file info and calculate duration
      const stats = fs.statSync(audioFilePath);
      debugLog('SERVICE', `File size: ${stats.size} bytes`);
      
      const endTime = Date.now();
      const duration = startTime ? endTime - startTime : 0;
      
      // 3. Prepare request to transcription API
      debugLog('API', `Preparing API request for file: ${audioFilePath}`);
      
      const formData = new FormData();
      formData.append('file', fs.createReadStream(audioFilePath));
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'json');
      
      // 4. Call the API
      debugLog('API', 'Sending request to OpenAI API...');
      const response = await axios.post(this.apiUrl, formData, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'multipart/form-data'
        }
      });
      
      // 5. Get transcription result
      const transcriptionResult = response.data;
      debugLog('API', `Received API response`, { text: transcriptionResult.text });
      
      // 6. Find or create the user in database
      debugLog('MONGO', `Finding/creating user: ${userData.userId}`);
      
      // Check if MongoDB is connected
      if (User.db.readyState !== 1) {
        debugLog('ERROR', `MongoDB not connected. ReadyState: ${User.db.readyState}`);
        return {
          text: transcriptionResult.text,
          userId: userData.userId,
          username: userData.username,
          duration: duration
        };
      }
      
      const user = await User.findOrCreateUser({
        userId: userData.userId,
        username: userData.username,
        displayName: userData.displayName || userData.username
      });
      
      debugLog('MONGO', `User found/created: ${user.username}`, {
        userId: user.userId,
        firstSeen: user.firstSeen
      });
      
      // 7. Add transcription to user record
      debugLog('MONGO', `Adding transcription to user record`);
      
      const transcriptionData = {
        content: transcriptionResult.text,
        channelId: contextData.channelId,
        channelName: contextData.channelName,
        guildId: contextData.guildId,
        guildName: contextData.guildName,
        duration: duration,
        confidenceScore: transcriptionResult.confidence || 0,
        audioFilePath: process.env.STORE_AUDIO_FILES === 'true' ? audioFilePath : null
      };
      
      debugLog('MONGO', `Transcription data prepared`, transcriptionData);
      
      await user.addTranscription(transcriptionData);
      debugLog('MONGO', `Transcription saved to database`);
      
      // 8. Return full result
      return {
        text: transcriptionResult.text,
        userId: userData.userId,
        username: userData.username,
        duration: duration
      };
    } catch (error) {
      debugLog('ERROR', `Transcription or database error: ${error.message}`);
      debugLog('ERROR', error.stack);
      return null;
    }
  }
  
  /**
   * Get transcription history for a user
   */
  async getUserTranscriptions(userId, options = {}) {
    debugLog('SERVICE', `getUserTranscriptions called for ${userId}`, options);
    
    try {
      const query = { userId };
      const limit = options.limit || 100;
      const skip = options.skip || 0;
      
      // Get the user
      debugLog('MONGO', `Finding user: ${userId}`);
      const user = await User.findOne(query);
      
      if (!user) {
        debugLog('MONGO', `User not found: ${userId}`);
        return [];
      }
      
      debugLog('MONGO', `User found with ${user.transcriptions.length} transcriptions`);
      
      // Get transcriptions with filtering
      let transcriptions = user.transcriptions;
      
      // Apply filters if provided
      if (options.guildId) {
        transcriptions = transcriptions.filter(t => t.guildId === options.guildId);
      }
      
      if (options.channelId) {
        transcriptions = transcriptions.filter(t => t.channelId === options.channelId);
      }
      
      if (options.startDate) {
        transcriptions = transcriptions.filter(t => new Date(t.timestamp) >= new Date(options.startDate));
      }
      
      if (options.endDate) {
        transcriptions = transcriptions.filter(t => new Date(t.timestamp) <= new Date(options.endDate));
      }
      
      // Sort by newest first, then apply pagination
      const result = transcriptions
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(skip, skip + limit);
      
      debugLog('SERVICE', `Returning ${result.length} transcriptions`);
      return result;
    } catch (error) {
      debugLog('ERROR', `Error fetching user transcriptions: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Get user statistics
   */
  async getUserStats(userId) {
    debugLog('SERVICE', `getUserStats called for ${userId}`);
    
    try {
      debugLog('MONGO', `Finding user: ${userId}`);
      const user = await User.findOne({ userId });
      
      if (!user) {
        debugLog('MONGO', `User not found: ${userId}`);
        return null;
      }
      
      debugLog('MONGO', `User found, returning stats`);
      
      return {
        userId: user.userId,
        username: user.username,
        totalTranscriptions: user.stats.totalTranscriptions,
        totalSpeakingTime: user.stats.totalSpeakingTime,
        averageConfidence: user.stats.averageConfidence,
        firstSeen: user.firstSeen,
        lastActive: user.lastActive
      };
    } catch (error) {
      debugLog('ERROR', `Error fetching user stats: ${error.message}`);
      return null;
    }
  }
}

module.exports = new TranscriptionService();