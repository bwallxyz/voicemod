// Script to clear/remove all slash commands from a Discord bot
const { REST, Routes } = require('discord.js');
require('dotenv').config();

// Your bot's token from the .env file
const token = process.env.DISCORD_TOKEN;

// Your bot's client ID (application ID)
// You can find this in the Discord Developer Portal
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

// Create a new REST instance
const rest = new REST({ version: '10' }).setToken(token);

async function clearGlobalCommands() {
  try {
    console.log('Started clearing global application (/) commands.');
    
    // The body is an empty array as we want to overwrite all commands with nothing
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: [] },
    );
    
    console.log('Successfully cleared global application (/) commands.');
  } catch (error) {
    console.error('Error clearing global commands:', error);
  }
}

async function clearGuildCommands(guildId) {
  // If no guild ID is specified, only clear global commands
  if (!guildId) {
    console.log('No Guild ID specified. Only clearing global commands.');
    return await clearGlobalCommands();
  }
  
  try {
    console.log(`Started clearing application (/) commands from guild ${guildId}.`);
    
    // Clear guild-specific commands
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: [] },
    );
    
    console.log(`Successfully cleared application (/) commands from guild ${guildId}.`);
    
    // Also clear global commands
    await clearGlobalCommands();
  } catch (error) {
    console.error('Error clearing guild commands:', error);
  }
}

// Get guild ID from command line argument
const guildId = process.argv[2];

// Call the function to clear commands
clearGuildCommands(guildId);

/*
 * To use this script:
 * 
 * 1. Make sure your .env file contains CLIENT_ID and DISCORD_TOKEN
 * 2. To clear both global and guild commands:
 *    node scripts/clear-commands.js YOUR_GUILD_ID
 * 
 * 3. To clear only global commands:
 *    node scripts/clear-commands.js
 */