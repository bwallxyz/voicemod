// Discord Voice Transcription Bot with Optional MongoDB Integration
// This bot connects to voice channels, records conversations,
// uses AI to transcribe and tag speakers, and optionally logs data to MongoDB

const { Client, GatewayIntentBits, Partials, Events } = require('discord.js')

// Fallback function to transcribe audio using the API directly (if database connection fails)
async function transcribeAudio(audioFilePath, userId) {
  debugLog('API', `Transcribing file: ${audioFilePath}`);
  try {
    // First check if file exists
    if (!fs.existsSync(audioFilePath)) {
      debugLog('ERROR', `Audio file not found: ${audioFilePath}`);
      return null;
    }
    
    // Check file size - if too small, probably not worth transcribing
    const stats = fs.statSync(audioFilePath);
    if (stats.size < 1000) {
      debugLog('API', `Audio file too small to transcribe: ${audioFilePath} (${stats.size} bytes)`);
      return null;
    }
    
    // Create form data - ensure FormData is properly imported
    const form = new FormData();
    
    form.append('file', fs.createReadStream(audioFilePath), {
      filename: 'audio.wav',
      contentType: 'audio/wav'
    });
    form.append('model', process.env.TRANSCRIPTION_MODEL || 'whisper-1');
    form.append('response_format', 'json');
    
    // Check for API key
    if (!API_KEY) {
      debugLog('ERROR', 'Missing OpenAI API key');
      return null;
    }
    
    debugLog('API', 'Sending request to OpenAI API...');
    
    const response = await axios.post(TRANSCRIPTION_API_URL, form, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        ...form.getHeaders()
      },
      maxBodyLength: Infinity, // For larger audio files
      timeout: 60000 // Increase timeout for larger files (60s)
    });
    
    if (response.data && response.data.text) {
      debugLog('API', `Transcription completed for ${userId}: "${response.data.text}"`);
      
      return {
        text: response.data.text,
        userId: userId
      };
    } else {
      debugLog('ERROR', 'Empty response from OpenAI API');
      return null;
    }
  } catch (error) {
    debugLog('ERROR', `API Transcription error: ${error.message}`);
    if (error.response) {
      debugLog('ERROR', `API Response Status: ${error.response.status}`);
      debugLog('ERROR', `API Response Data:`, error.response.data);
    }
    return null;
  }
}

const fs = require('fs');
const path = require('path');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType
} = require('@discordjs/voice');
const axios = require('axios');
const FormData = require('form-data');
const prism = require('prism-media');
require('dotenv').config();

// Debug logging function with timestamps
function debugLog(area, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${area}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// Check critical environment variables
const criticalEnvVars = [
  'DISCORD_TOKEN',
  'OPENAI_API_KEY'
];

let missingVars = [];
criticalEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    missingVars.push(varName);
  }
});

if (missingVars.length > 0) {
  console.error('❌ Missing critical environment variables:', missingVars.join(', '));
  console.error('Please check your .env file');
  process.exit(1);
}

// Try disabling MongoDB temporarily if it's causing issues
if (process.env.DISABLE_MONGODB === 'true') {
  console.log('MongoDB is disabled by DISABLE_MONGODB environment variable');
  process.env.USE_MONGODB = 'false';
}

// Set a global flag indicating if MongoDB should be used
const USE_MONGODB = process.env.USE_MONGODB === 'true';

// Create recordings directory if it doesn't exist
const recordingsDir = path.join(__dirname, process.env.RECORDINGS_DIR || 'recordings');
if (!fs.existsSync(recordingsDir)) {
  debugLog('STARTUP', `Creating recordings directory: ${recordingsDir}`);
  fs.mkdirSync(recordingsDir, { recursive: true });
}

// Only import database modules if MongoDB is enabled
let connectDatabase, mongoose, transcriptionService, User;

if (USE_MONGODB) {
  try {
    const dbModule = require('./database');
    connectDatabase = dbModule.connectDatabase;
    mongoose = dbModule.mongoose;
    
    transcriptionService = require('./services/transcriptionService');
    User = require('./models/User');
    
    debugLog('STARTUP', 'MongoDB modules loaded successfully');
  } catch (error) {
    debugLog('ERROR', `Failed to load MongoDB modules: ${error.message}`);
    debugLog('CONFIG', 'Continuing without database functionality');
  }
}

// Create a new Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel]
});

// Map to store voice connections
const connections = new Map();
// Map to store user audio streams
const userAudioStreams = new Map();
// Map to store user session data (for speaker identification)
const userSessions = new Map();

// API configuration for the transcription service
// This example uses OpenAI's Whisper API, but you can substitute any speech-to-text API
const TRANSCRIPTION_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const API_KEY = process.env.OPENAI_API_KEY;

// Register command listeners
client.once(Events.ClientReady, async () => {
  debugLog('STARTUP', `Logged in as ${client.user.tag}!`);
  
  // Only try to connect to database if MongoDB is enabled
  if (USE_MONGODB) {
    try {
      debugLog('MONGO', `Attempting to connect to MongoDB: ${process.env.MONGODB_URI}`);
      const dbConnected = await connectDatabase();
      if (dbConnected) {
        debugLog('MONGO', 'Database connected and ready to log transcriptions');
        
        // Test database write
        try {
          // First check if test user already exists to avoid duplicate key error
          const existingUser = await User.findOne({ userId: 'test-user-id' });
          
          if (!existingUser) {
            const testUser = new User({
              userId: 'test-user-id',
              username: 'test-user'
            });
            
            await testUser.save();
            debugLog('MONGO', 'Test user saved successfully');
          } else {
            debugLog('MONGO', 'Test user already exists, skipping creation');
          }
          
          // Try finding the user
          const foundUser = await User.findOne({ userId: 'test-user-id' });
          debugLog('MONGO', 'Test user retrieved successfully', {
            found: !!foundUser,
            username: foundUser?.username
          });
        } catch (dbError) {
          debugLog('ERROR', `Database write test failed: ${dbError.message}`);
        }
      } else {
        debugLog('ERROR', 'Database connection failed. Transcription logging disabled.');
      }
    } catch (error) {
      debugLog('ERROR', `Error during database connection: ${error.message}`);
      debugLog('CONFIG', 'Continuing without database functionality');
    }
  } else {
    debugLog('CONFIG', 'MongoDB is disabled. Running without database functionality.');
  }
});

// Handle slash commands
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;
  debugLog('COMMAND', `Slash command received: ${commandName}`, {
    user: interaction.user.username,
    guild: interaction.guild?.name,
    options: interaction.options?.data
  });

  // Handle basic commands that don't need MongoDB
  if (commandName === 'starttranscribe') {
    await handleStartTranscribe(interaction);
  } else if (commandName === 'stoptranscribe') {
    await handleStopTranscribe(interaction);
  } else if (commandName === 'transcribestatus') {
    await handleTranscribeStatus(interaction);
  }
  
  // Only process these commands if MongoDB is available
  else if (USE_MONGODB && mongoose && mongoose.connection.readyState === 1) {
    // Handle mytranscripts command
    if (commandName === 'mytranscripts') {
      await interaction.deferReply({ ephemeral: true });
      
      const limit = interaction.options.getInteger('limit') || 10;
      const userId = interaction.user.id;
      
      debugLog('COMMAND', `Fetching transcripts for user: ${userId}`, { limit });
      
      const transcriptions = await transcriptionService.getUserTranscriptions(userId, {
        limit: limit
      });
      
      if (transcriptions.length === 0) {
        debugLog('COMMAND', `No transcriptions found for user: ${userId}`);
        await interaction.editReply('You don\'t have any transcriptions yet.');
        return;
      }
      
      debugLog('COMMAND', `Found ${transcriptions.length} transcriptions for user: ${userId}`);
      
      let reply = '**Your recent transcriptions:**\n\n';
      
      transcriptions.forEach((transcript, index) => {
        const date = new Date(transcript.timestamp).toLocaleString();
        reply += `**${index + 1}. ${date} in #${transcript.channelName}:**\n`;
        reply += `${transcript.content}\n\n`;
      });
      
      await interaction.editReply(reply);
    }
    
    // Handle mystats command
    else if (commandName === 'mystats') {
      await interaction.deferReply({ ephemeral: true });
      
      const userId = interaction.user.id;
      debugLog('COMMAND', `Fetching stats for user: ${userId}`);
      
      const stats = await transcriptionService.getUserStats(userId);
      
      if (!stats) {
        debugLog('COMMAND', `No stats found for user: ${userId}`);
        await interaction.editReply('You don\'t have any transcription statistics yet.');
        return;
      }
      
      debugLog('COMMAND', `Found stats for user: ${userId}`, stats);
      
      // Format speaking time nicely
      const totalMinutes = Math.floor(stats.totalSpeakingTime / 60000);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      const seconds = Math.floor((stats.totalSpeakingTime % 60000) / 1000);
      
      const speakingTime = hours > 0 
        ? `${hours}h ${minutes}m ${seconds}s`
        : `${minutes}m ${seconds}s`;
      
      const reply = `**Your Transcription Statistics**\n\n` +
                    `Total Transcriptions: ${stats.totalTranscriptions}\n` +
                    `Total Speaking Time: ${speakingTime}\n` +
                    `Average Confidence Score: ${stats.averageConfidence.toFixed(2)}%\n` +
                    `First Seen: ${new Date(stats.firstSeen).toLocaleString()}\n` +
                    `Last Active: ${new Date(stats.lastActive).toLocaleString()}`;
      
      await interaction.editReply(reply);
    }
  } else if (commandName === 'mytranscripts' || commandName === 'mystats') {
    // Handle the case where MongoDB commands are used but MongoDB is not available
    debugLog('COMMAND', `Database command ${commandName} used but MongoDB is not available`);
    await interaction.reply({ 
      content: 'Database functionality is currently unavailable. Please try again later or contact the bot administrator.',
      ephemeral: true 
    });
  }
});

// For backward compatibility, also handle text commands
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  
  // Command to start transcription
  if (message.content === '!starttranscribe') {
    debugLog('COMMAND', `Text command received: !starttranscribe`, {
      user: message.author.username,
      guild: message.guild?.name
    });
    await startTranscription(message.member.voice.channel, message);
  }
  
  // Command to stop transcription
  if (message.content === '!stoptranscribe') {
    debugLog('COMMAND', `Text command received: !stoptranscribe`, {
      user: message.author.username,
      guild: message.guild?.name
    });
    await stopTranscription(message.guild.id, message);
  }
});

// Handle the start transcribe command
async function handleStartTranscribe(interaction) {
  await interaction.deferReply();
  
  const voiceChannel = interaction.member.voice.channel;
  
  if (!voiceChannel) {
    debugLog('COMMAND', `User not in voice channel: ${interaction.user.username}`);
    await interaction.editReply('You need to be in a voice channel to use this command!');
    return;
  }
  
  await startTranscription(voiceChannel, interaction);
}

// Handle the stop transcribe command
async function handleStopTranscribe(interaction) {
  await interaction.deferReply();
  await stopTranscription(interaction.guild.id, interaction);
}

// Handle the transcribe status command
async function handleTranscribeStatus(interaction) {
  await interaction.deferReply();
  
  const connection = connections.get(interaction.guild.id);
  
  if (connection) {
    const voiceChannelId = connection.joinConfig.channelId;
    const voiceChannel = interaction.guild.channels.cache.get(voiceChannelId);
    
    debugLog('COMMAND', `Transcription status requested, active in: ${voiceChannel.name}`);
    await interaction.editReply(`Transcription is active in channel: ${voiceChannel.name}`);
  } else {
    debugLog('COMMAND', `Transcription status requested, no active transcription`);
    await interaction.editReply('No active transcription in this server.');
  }
}

// Start transcription in a voice channel
async function startTranscription(voiceChannel, responseObj) {
  if (!voiceChannel) {
    respondToUser(responseObj, 'You need to be in a voice channel to use this command!');
    return;
  }
  
  try {
    // Check if we're already connected to this voice channel
    if (connections.has(voiceChannel.guild.id)) {
      debugLog('VOICE', `Transcription already active in guild: ${voiceChannel.guild.name}`);
      respondToUser(responseObj, 'Transcription is already active in this server.');
      return;
    }
    
    debugLog('VOICE', `Starting transcription in channel: ${voiceChannel.name}`);
    
    // Create a new connection to the voice channel
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    
    // Store the connection
    connections.set(voiceChannel.guild.id, connection);
    
    // Notify when the connection is ready
    connection.on(VoiceConnectionStatus.Ready, () => {
      debugLog('VOICE', `Connection ready in channel: ${voiceChannel.name}`);
      respondToUser(responseObj, `Voice transcription started in ${voiceChannel.name}. I'll transcribe the conversation.`);
      
      // Get all users currently in the voice channel
      debugLog('VOICE', `Setting up receivers for ${voiceChannel.members.size} members in channel`);
      voiceChannel.members.forEach(member => {
        if (!member.user.bot) {
          debugLog('VOICE', `Setting up receiver for existing member: ${member.user.username}`);
          setupUserAudioReceiver(connection, member.id, member.user.username);
        }
      });
    });
    
    // Handle connection state changes
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      debugLog('VOICE', `Disconnected from voice channel: ${voiceChannel.name}`);
    });
    
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      debugLog('VOICE', `Connection destroyed for channel: ${voiceChannel.name}`);
    });
    
    // Handle new users joining the voice channel
    // We need to use client's "voiceStateUpdate" event instead
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      // Only process if this is for the guild we're monitoring
      if (newState.guild.id !== voiceChannel.guild.id) return;
      
      // Check if a user has joined the voice channel we're monitoring
      if (newState.channelId === voiceChannel.id && 
          (!oldState.channelId || oldState.channelId !== voiceChannel.id)) {
        
        // Skip bot users
        if (newState.member.user.bot) return;
        
        debugLog('VOICE', `User ${newState.member.user.username} joined voice channel ${voiceChannel.name}`);
        setupUserAudioReceiver(connection, newState.member.id, newState.member.user.username);
      }
    });
    
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (error) {
    debugLog('ERROR', `Failed to start transcription: ${error.message}`, {
      stack: error.stack,
      guild: voiceChannel.guild.name,
      channel: voiceChannel.name
    });
    respondToUser(responseObj, 'Failed to start transcription. Please try again.');
  }
}

// Stop transcription in a server
async function stopTranscription(guildId, responseObj) {
  const connection = connections.get(guildId);
  
  if (connection) {
    debugLog('VOICE', `Stopping transcription in guild ID: ${guildId}`);
    connection.destroy();
    connections.delete(guildId);
    
    // Clean up user audio streams
    let cleanedStreams = 0;
    userAudioStreams.forEach((stream, userId) => {
      if (userId.startsWith(guildId)) {
        stream.destroy();
        userAudioStreams.delete(userId);
        cleanedStreams++;
      }
    });
    
    debugLog('VOICE', `Cleaned up ${cleanedStreams} audio streams`);
    respondToUser(responseObj, 'Voice transcription stopped.');
  } else {
    debugLog('VOICE', `No active transcription to stop in guild ID: ${guildId}`);
    respondToUser(responseObj, 'No active transcription to stop.');
  }
}

// Helper function to respond to both slash commands and messages
function respondToUser(responseObj, message) {
  if (responseObj.editReply) {
    // It's an interaction
    responseObj.editReply(message).catch(err => {
      debugLog('ERROR', `Failed to edit reply: ${err.message}`);
    });
  } else {
    // It's a message
    responseObj.reply(message).catch(err => {
      debugLog('ERROR', `Failed to reply to message: ${err.message}`);
    });
  }
}

// Function to set up audio receiving for a user
function setupUserAudioReceiver(connection, userId, username) {
  // Create a unique ID for this user in this guild
  const guildUserId = `${connection.joinConfig.guildId}-${userId}`;
  
  // Skip if we're already receiving audio from this user
  if (userAudioStreams.has(guildUserId)) {
    debugLog('SETUP', `Already receiving audio from user: ${username} (${userId})`);
    return;
  }
  
  debugLog('SETUP', `Setting up audio receiver for user: ${username} (${userId})`);
  
  // Store user session data
  userSessions.set(guildUserId, {
    username: username,
    lastTranscription: Date.now()
  });
  
  // Create an audio receiver for this user
  const receiver = connection.receiver;
  
  try {
    // Start listening to the user's audio with more robust error handling
    const audioStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1000, // Increased from 500ms for more stability
      },
    });
    
    // Add error handling immediately
    audioStream.on('error', (error) => {
      debugLog('ERROR', `Audio stream error for ${username}: ${error.message}`);
      // Remove from tracked streams if error occurs
      userAudioStreams.delete(guildUserId);
    });
    
    // Store in map only after adding error handler
    userAudioStreams.set(guildUserId, audioStream);
    
    // Track active output streams for this user
    const activeOutputStreams = new Set();
    
    // Process the audio stream - USING WAV INSTEAD OF PCM
    let recordingStartTime = Date.now();
    let outputPath = path.join(recordingsDir, `${guildUserId}-${recordingStartTime}.wav`);
    debugLog('AUDIO', `Creating WAV recording file: ${outputPath}`);
    
    // Create a WAV encoder
    const wavEncoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 })
      .pipe(new prism.VolumeTransformer({ type: 's16le' }))
      .pipe(new prism.PCMToWav({ 
        sampleRate: 48000, 
        channels: 2,
        format: 's16le'
      }));
    
    // Create file write stream
    let outputStream = fs.createWriteStream(outputPath);
    
    // Add to active streams set
    activeOutputStreams.add(outputStream);
    activeOutputStreams.add(wavEncoder);
    
    debugLog('AUDIO', `Created recording file: ${outputPath}`);
    
    // Add error handlers
    wavEncoder.on('error', (err) => {
      debugLog('ERROR', `WAV encoder error for ${username}: ${err.message}`);
    });
    
    outputStream.on('error', (err) => {
      debugLog('ERROR', `Output stream error for ${username}: ${err.message}`);
    });
    
    // Pipe with error handling
    try {
      // Connect the audio stream to the WAV encoder to the file
      audioStream.pipe(wavEncoder).pipe(outputStream);
    } catch (pipeError) {
      debugLog('ERROR', `Failed to pipe audio stream: ${pipeError.message}`);
    }
    
    // Set up a silence detection mechanism with recovery capability
    let silenceStart = null;
    let isSpeaking = false;
    let lastActivity = Date.now();
    
    // Add a watchdog timer to detect stalled streams
    const watchdogInterval = setInterval(() => {
      if (Date.now() - lastActivity > 60000) { // 1 minute of inactivity
        debugLog('WATCHDOG', `No activity for ${username} in 60 seconds, resetting connection`);
        
        // Reset the receiver by recreating it
        try {
          // Clean up first
          clearInterval(watchdogInterval);
          
          // Remove the old stream
          if (userAudioStreams.has(guildUserId)) {
            const oldStream = userAudioStreams.get(guildUserId);
            oldStream.unpipe();
            oldStream.destroy();
            userAudioStreams.delete(guildUserId);
          }
          
          // Clean up streams
          for (const stream of activeOutputStreams) {
            try {
              stream.end();
            } catch (err) {
              debugLog('ERROR', `Error ending stream in watchdog: ${err.message}`);
            }
          }
          activeOutputStreams.clear();
          
          // Wait a second before trying to reconnect
          setTimeout(() => {
            debugLog('WATCHDOG', `Attempting to reconnect audio for ${username}`);
            setupUserAudioReceiver(connection, userId, username);
          }, 1000);
        } catch (resetError) {
          debugLog('ERROR', `Error in watchdog reset: ${resetError.message}`);
        }
      }
    }, 10000); // Check every 10 seconds
    
    audioStream.on('data', (chunk) => {
      // Update watchdog timestamp
      lastActivity = Date.now();
      
      // Check if the chunk contains non-silence audio (more robust check)
      let containsAudio = false;
      
      // Sample at least 20% of the buffer for non-zero values
      const sampleSize = Math.max(100, Math.floor(chunk.length * 0.2));
      const step = Math.floor(chunk.length / sampleSize);
      
      for (let i = 0; i < chunk.length; i += step) {
        if (chunk[i] !== 0) {
          containsAudio = true;
          break;
        }
      }
      
      if (containsAudio && !isSpeaking) {
        isSpeaking = true;
        silenceStart = null;
        debugLog('AUDIO', `User ${username} started speaking`);
      } else if (!containsAudio && isSpeaking) {
        if (!silenceStart) {
          silenceStart = Date.now();
        } else if (Date.now() - silenceStart > (parseInt(process.env.SILENCE_DURATION) || 2000)) {
          // If silence for more than configured duration, consider the speech finished
          isSpeaking = false;
          debugLog('AUDIO', `User ${username} finished speaking, processing audio from ${outputPath}`);
          
          try {
            // Get voice channel and guild information
            const guild = client.guilds.cache.get(connection.joinConfig.guildId);
            const channel = guild.channels.cache.get(connection.joinConfig.channelId);
            
            // Get full user info
            const member = guild.members.cache.get(userId);
            const displayName = member ? member.displayName : username;
            
            // Store current output path and start time for transcription
            const currentOutputPath = outputPath;
            const currentStartTime = recordingStartTime;
            
            // IMPORTANT: Create a local reference to this output stream and wav encoder
            const currentOutputStream = outputStream;
            const currentWavEncoder = wavEncoder;
            
            // Create new recording file before doing anything with the old one
            // Start a new recording file (IMPORTANT: Do this BEFORE ending the old stream)
            debugLog('AUDIO', `Starting new recording for ${username}`);
            
            // Create new recording stream with WAV encoding
            recordingStartTime = Date.now();
            outputPath = path.join(recordingsDir, `${guildUserId}-${recordingStartTime}.wav`);
            
            // Create a new WAV encoder
            wavEncoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 })
              .pipe(new prism.VolumeTransformer({ type: 's16le' }))
              .pipe(new prism.PCMToWav({ 
                sampleRate: 48000, 
                channels: 2,
                format: 's16le'
              }));
            
            // Create new output stream
            outputStream = fs.createWriteStream(outputPath);
            
            // Add the new stream to active streams
            activeOutputStreams.add(outputStream);
            activeOutputStreams.add(wavEncoder);
            
            // Add error handlers
            wavEncoder.on('error', (err) => {
              debugLog('ERROR', `WAV encoder error for ${username}: ${err.message}`);
            });
            
            outputStream.on('error', (err) => {
              debugLog('ERROR', `Output stream error for ${username}: ${err.message}`);
            });
            
            try {
              // IMPORTANT: Unpipe BEFORE ending the old stream
              audioStream.unpipe(currentWavEncoder);
              
              // Now pipe to the new wav encoder and stream
              audioStream.pipe(wavEncoder).pipe(outputStream);
            } catch (pipeError) {
              debugLog('ERROR', `Failed to switch pipes: ${pipeError.message}`);
            }
            
            // Use MongoDB if available
            if (USE_MONGODB && mongoose && mongoose.connection.readyState === 1) {
              debugLog('MONGO', `Using MongoDB transcription service for ${username}`);
              
              // Prepare context data for transcription
              const contextData = {
                guildId: guild.id,
                guildName: guild.name,
                channelId: channel.id,
                channelName: channel.name
              };
              
              // Prepare user data
              const userData = {
                userId: userId,
                username: username,
                displayName: displayName
              };
              
              debugLog('CONTEXT', 'Transcription context', contextData);
              debugLog('USER', 'User data', userData);
              
              // Transcribe the audio and save to database
              transcriptionService.transcribeAndSave(
                currentOutputPath, 
                userData, 
                contextData, 
                currentStartTime
              ).then(result => {
                if (result && result.text) {
                  debugLog('TRANSCRIPTION', `Success for ${result.username}: "${result.text}"`);
                  // Send the transcription to the text channel
                  const textChannelId = guild.systemChannelId;
                  const textChannel = client.channels.cache.get(textChannelId);
                  
                  if (textChannel) {
                    textChannel.send(`**${result.username}**: ${result.text}`);
                  }
                } else {
                  debugLog('TRANSCRIPTION', `Empty result for ${username}`);
                }
              }).catch(error => {
                debugLog('ERROR', `Transcription service error: ${error.message}`);
                // Fallback to direct transcription on error
                transcribeAudio(currentOutputPath, guildUserId).then(handleTranscription);
              }).finally(() => {
                // Clean up the stream reference from active streams set
                activeOutputStreams.delete(currentOutputStream);
                activeOutputStreams.delete(currentWavEncoder);
                
                // Safely end the previous stream and avoid race conditions
                setTimeout(() => {
                  try {
                    currentWavEncoder.end();
                    currentOutputStream.end();
                  } catch (err) {
                    debugLog('ERROR', `Error ending stream: ${err.message}`);
                  }
                }, 500);
              });
            } else {
              debugLog('DIRECT', `Using direct API transcription for ${username}`);
              transcribeAudio(currentOutputPath, guildUserId)
                .then(handleTranscription)
                .finally(() => {
                  // Clean up the stream reference from active streams set
                  activeOutputStreams.delete(currentOutputStream);
                  activeOutputStreams.delete(currentWavEncoder);
                  
                  // Safely end the previous stream and avoid race conditions
                  setTimeout(() => {
                    try {
                      currentWavEncoder.end();
                      currentOutputStream.end();
                    } catch (err) {
                      debugLog('ERROR', `Error ending stream: ${err.message}`);
                    }
                  }, 500);
                });
            }
            
            // Function to handle transcription result
            function handleTranscription(result) {
              if (result && result.text) {
                debugLog('TRANSCRIPTION', `Direct API success: "${result.text}"`);
                const userSession = userSessions.get(guildUserId);
                
                if (channel && userSession) {
                  // Send the transcription to the text channel
                  const textChannelId = guild.systemChannelId;
                  const textChannel = client.channels.cache.get(textChannelId);
                  
                  if (textChannel) {
                    textChannel.send(`**${userSession.username}**: ${result.text}`);
                  }
                  
                  // Update the user's last transcription time
                  userSession.lastTranscription = Date.now();
                }
              } else {
                debugLog('TRANSCRIPTION', `Direct API failed for ${username}`);
              }
            }
          } catch (processingError) {
            debugLog('ERROR', `Error processing end of speech: ${processingError.message}`);
          }
        }
      }
    });
    
    // Handle stream closing with more robustness
    audioStream.on('close', (reason) => {
      debugLog('AUDIO', `Audio stream closed for user: ${username}, reason: ${reason || 'unknown'}`);
      
      // Clear the watchdog
      clearInterval(watchdogInterval);
      
      // Properly clean up all active streams
      for (const stream of activeOutputStreams) {
        try {
          stream.end();
        } catch (err) {
          debugLog('ERROR', `Error ending stream on close: ${err.message}`);
        }
      }
      
      // Clear the active streams set
      activeOutputStreams.clear();
      
      // Remove from tracked audio streams
      userAudioStreams.delete(guildUserId);
      
      // Try to recover automatically after a short delay
      setTimeout(() => {
        if (!userAudioStreams.has(guildUserId) && connection && !connection.destroyed) {
          debugLog('RECOVERY', `Attempting to recover audio for ${username}`);
          setupUserAudioReceiver(connection, userId, username);
        }
      }, 2000);
    });
    
  } catch (setupError) {
    debugLog('ERROR', `Failed to set up audio receiver: ${setupError.message}`);
    
    // Try again after a delay
    setTimeout(() => {
      debugLog('RECOVERY', `Retrying setup for ${username}`);
      if (!userAudioStreams.has(guildUserId)) {
        setupUserAudioReceiver(connection, userId, username);
      }
    }, 3000);
  }
}


// Log in to Discord
console.log('Logging in to Discord...');
client.login(process.env.DISCORD_TOKEN)
.catch(error => {
  console.error(`Failed to login to Discord: ${error.message}`);
  process.exit(1);
});