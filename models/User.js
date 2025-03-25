// models/User.js
const mongoose = require('mongoose');

// Schema for individual transcription entries
const TranscriptionSchema = new mongoose.Schema({
  // When the transcription was created
  timestamp: {
    type: Date,
    default: Date.now
  },
  
  // The actual transcribed text
  content: {
    type: String,
    required: true
  },
  
  // Which voice channel this was from
  channelId: {
    type: String,
    required: true
  },
  
  // Channel name for easier reference
  channelName: {
    type: String,
    required: true
  },
  
  // Server/guild where this occurred
  guildId: {
    type: String,
    required: true
  },
  
  // Guild name for easier reference
  guildName: {
    type: String,
    required: true
  },
  
  // Duration of the speech segment in milliseconds
  duration: {
    type: Number,
    default: 0
  },
  
  // Confidence score from the transcription service (if available)
  confidenceScore: {
    type: Number,
    default: 0
  },
  
  // Path to the audio file (if we choose to store the recordings)
  audioFilePath: {
    type: String,
    default: null
  }
});

// Main user schema
const UserSchema = new mongoose.Schema({
  // Discord user ID
  userId: {
    type: String,
    required: true,
    unique: true
  },
  
  // Discord username
  username: {
    type: String,
    required: true
  },
  
  // Optional display name (nickname)
  displayName: {
    type: String,
    default: null
  },
  
  // When this user was first seen by the bot
  firstSeen: {
    type: Date,
    default: Date.now
  },
  
  // When this user was last seen speaking
  lastActive: {
    type: Date,
    default: Date.now
  },
  
  // Array of all transcriptions for this user
  transcriptions: [TranscriptionSchema],
  
  // Statistics about the user's transcriptions
  stats: {
    totalTranscriptions: {
      type: Number,
      default: 0
    },
    totalSpeakingTime: {
      type: Number,
      default: 0 // in milliseconds
    },
    averageConfidence: {
      type: Number,
      default: 0
    }
  }
});

// Add methods to the schema
UserSchema.methods.addTranscription = function(transcriptionData) {
  // Add the new transcription to the array
  this.transcriptions.push(transcriptionData);
  
  // Update stats
  this.stats.totalTranscriptions += 1;
  this.stats.totalSpeakingTime += transcriptionData.duration || 0;
  
  if (transcriptionData.confidenceScore) {
    // Update running average of confidence scores
    const totalConfidence = this.stats.averageConfidence * (this.stats.totalTranscriptions - 1);
    this.stats.averageConfidence = (totalConfidence + transcriptionData.confidenceScore) / this.stats.totalTranscriptions;
  }
  
  // Update last active timestamp
  this.lastActive = Date.now();
  
  return this.save();
};

// Create a static method to find or create a user
UserSchema.statics.findOrCreateUser = async function(userData) {
  let user = await this.findOne({ userId: userData.userId });
  
  if (!user) {
    user = new this({
      userId: userData.userId,
      username: userData.username,
      displayName: userData.displayName
    });
    await user.save();
  }
  
  return user;
};

// Create and export the model
const User = mongoose.model('User', UserSchema);
module.exports = User;