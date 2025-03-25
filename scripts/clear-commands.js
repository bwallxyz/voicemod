// Script to clear/remove all slash commands from a Discord bot
const { REST, Routes } = require('discord.js');
require('dotenv').config();

// Your bot's token from the .env file
const token = process.env.DISCORD_TOKEN;

// Your bot's client ID (application ID)
// You can find this in the Discord Developer Portal
const clientId = process.env.CLIENT_ID || 'YOUR_CLIENT_ID_HERE';

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
 * 1. Add your CLIENT_ID to your .env file or replace it in this file
 * 2. To clear both global and guild commands:
 *    node clear-commands.js YOUR_GUILD_ID
 * 
 * 3. To clear only global commands:
 *    node clear-commands.js
 */