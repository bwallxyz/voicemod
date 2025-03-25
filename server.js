// Discord Voice Transcription Bot with Optional MongoDB Integration
// This bot connects to voice channels, records conversations,
// uses AI to transcribe and tag speakers, and optionally logs data to MongoDB

const { Client, GatewayIntentBits, Partials, Events, InteractionType } = require('discord.js');
const { createWriteStream, createReadStream } = require('fs');
const { join } = require('path');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType
} = require('@discordjs/voice');
const axios = require('axios');
require('dotenv').config();

// Debug logging function with timestamps
function debugLog(area, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${area}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// Set a global flag indicating if MongoDB should be used
const USE_MONGODB = process.env.USE_MONGODB === 'true';

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
          const testUser = new User({
            userId: 'test-user-id',
            username: 'test-user'
          });
          
          await testUser.save();
          debugLog('MONGO', 'Test user saved successfully');
          
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
    responseObj.editReply(message);
  } else {
    // It's a message
    responseObj.reply(message);
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
  
  // Start listening to the user's audio
  const audioStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 500,
    },
  });
  
  userAudioStreams.set(guildUserId, audioStream);
  
  // Process the audio stream
  const recordingStartTime = Date.now();
  const outputPath = join(__dirname, process.env.RECORDINGS_DIR || 'recordings', `${guildUserId}-${recordingStartTime}.pcm`);
  const outputStream = createWriteStream(outputPath);
  
  debugLog('AUDIO', `Created recording file: ${outputPath}`);
  
  audioStream.pipe(outputStream);
  
  // Set up a silence detection mechanism
  let silenceStart = null;
  let isSpeaking = false;
  
  audioStream.on('data', (chunk) => {
    // Check if the chunk contains non-silence audio
    const containsAudio = chunk.some(byte => byte !== 0);
    
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
        
        // Get voice channel and guild information
        const guild = client.guilds.cache.get(connection.joinConfig.guildId);
        const channel = guild.channels.cache.get(connection.joinConfig.channelId);
        
        // Get full user info
        const member = guild.members.cache.get(userId);
        const displayName = member ? member.displayName : username;
        
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
            outputPath, 
            userData, 
            contextData, 
            recordingStartTime
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
            transcribeAudio(outputPath, guildUserId).then(handleTranscription);
          });
        } else {
          debugLog('DIRECT', `Using direct API transcription for ${username}`);
          transcribeAudio(outputPath, guildUserId).then(handleTranscription);
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
        
        // Start a new recording file
        debugLog('AUDIO', `Starting new recording for ${username}`);
        audioStream.unpipe(outputStream);
        outputStream.end();
        
        const newStartTime = Date.now();
        const newOutputPath = join(__dirname, process.env.RECORDINGS_DIR || 'recordings', `${guildUserId}-${newStartTime}.pcm`);
        const newOutputStream = createWriteStream(newOutputPath);
        
        audioStream.pipe(newOutputStream);
      }
    }
  });
  
  // Handle stream closing
  audioStream.on('close', (reason) => {
    debugLog('AUDIO', `Audio stream closed for user: ${username}, reason: ${reason || 'unknown'}`);
    outputStream.end();
    userAudioStreams.delete(guildUserId);
  });
  
  // Handle stream errors
  audioStream.on('error', (error) => {
    debugLog('ERROR', `Audio stream error for ${username}: ${error.message}`);
  });
}

// Fallback function to transcribe audio using the API directly (if database connection fails)
async function transcribeAudio(audioFilePath, userId) {
  debugLog('API', `Transcribing file: ${audioFilePath}`);
  try {
    const formData = new FormData();
    formData.append('file', createReadStream(audioFilePath));
    formData.append('model', process.env.TRANSCRIPTION_MODEL || 'whisper-1');
    formData.append('response_format', 'json');
    
    debugLog('API', 'Sending request to OpenAI API...');
    
    const response = await axios.post(TRANSCRIPTION_API_URL, formData, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'multipart/form-data'
      }
    });
    
    debugLog('API', `Transcription completed for ${userId}`);
    
    return {
      text: response.data.text,
      userId: userId
    };
  } catch (error) {
    debugLog('ERROR', `API Transcription error: ${error.message}`);
    return null;
  }
}

// Log in to Discord
debugLog('STARTUP', 'Logging in to Discord...');
client.login(process.env.DISCORD_TOKEN);