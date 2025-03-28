// Script to deploy slash commands to a specific guild/server
const { REST, Routes } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
require('dotenv').config();

// Your bot's token from the .env file
const token = process.env.DISCORD_TOKEN;

// Your bot's client ID (application ID)
const clientId = process.env.CLIENT_ID;

// Check if token and client ID are available
if (!token) {
  console.error('Error: DISCORD_TOKEN is missing in your .env file');
  process.exit(1);
}

if (!clientId) {
  console.error('Error: CLIENT_ID is missing in your .env file');
  process.exit(1);
}

// Define the commands for your bot
const commands = [
  // Start transcription command
  new SlashCommandBuilder()
    .setName('starttranscribe')
    .setDescription('Start transcribing the current voice channel')
    .toJSON(),
  
  // Stop transcription command
  new SlashCommandBuilder()
    .setName('stoptranscribe')
    .setDescription('Stop transcribing the current voice channel')
    .toJSON(),
    
  // Get transcription status
  new SlashCommandBuilder()
    .setName('transcribestatus')
    .setDescription('Check if transcription is currently active')
    .toJSON(),
    
  // View your transcription history
  new SlashCommandBuilder()
    .setName('mytranscripts')
    .setDescription('View your transcription history')
    .addIntegerOption(option => 
      option.setName('limit')
        .setDescription('Number of transcripts to show (default: 10)')
        .setRequired(false))
    .toJSON(),
    
  // View your transcription statistics
  new SlashCommandBuilder()
    .setName('mystats')
    .setDescription('View your transcription statistics')
    .toJSON(),
];

// Create a new REST instance
const rest = new REST({ version: '10' }).setToken(token);

async function deployCommands(guildId) {
  try {
    console.log('Started refreshing application (/) commands...');
    
    if (guildId) {
      // Guild commands - deploy to a specific server (faster, but only in that server)
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands },
      );
      console.log(`Successfully deployed ${commands.length} guild commands to guild ${guildId}`);
    } else {
      // Global commands - deploy to all servers (takes up to an hour to propagate)
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands },
      );
      console.log(`Successfully deployed ${commands.length} global commands (may take up to an hour to appear)`);
    }
  } catch (error) {
    console.error('Error deploying commands:', error);
  }
}

// Get the guild ID from command line arguments
const guildId = process.argv[2];

// Deploy the commands
deployCommands(guildId);

/*
 * To use this script:
 * 
 * 1. Make sure your .env file contains CLIENT_ID and DISCORD_TOKEN
 * 2. To deploy to a specific guild/server (recommended during development):
 *    node scripts/deploy-commands.js YOUR_GUILD_ID
 * 
 * 3. To deploy globally to all servers (takes up to an hour to propagate):
 *    node scripts/deploy-commands.js
 */