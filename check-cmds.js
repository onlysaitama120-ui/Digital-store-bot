const { REST } = require('discord.js');
const config = require('./config.json');

const rest = new REST({ version: '10' }).setToken(config.token);
const botId = '1537944941194641528';

async function main() {
    // 1. Check application settings (DM permission)
    try {
        const app = await rest.get('/applications/@me');
        console.log('=== Application ===');
        console.log('Name:', app.name);
        console.log('Bot public:', app.bot_public);
        console.log('Bot requires OAuth code grant:', app.bot_require_code_grant);
        console.log('Bot DM behavior:', JSON.stringify(app.bot_dm_settings || 'not set'));
    } catch (e) {
        console.log('App check failed:', e.message);
    }

    // 2. Check GLOBAL commands
    try {
        const globals = await rest.get(`/applications/${botId}/commands`);
        console.log('/n=== GLOBAL COMMANDS (' + globals.length + ') ===');
        globals.forEach(c => console.log('  /' + c.name + ' - id:' + c.id));
    } catch (e) {
        console.log('/nGlobal command check failed:', e.message);
    }

    // 3. Check GUILD commands (first guild from config)
    if (config.guildId) {
        try {
            const guildCmds = await rest.get(`/applications/${botId}/guilds/${config.guildId}/commands`);
            console.log('/n=== GUILD COMMANDS for ' + config.guildId + ' (' + guildCmds.length + ') ===');
            guildCmds.forEach(c => console.log('  /' + c.name));
        } catch (e) {
            console.log('/nGuild command check failed:', e.message);
        }
    } else {
        console.log('/nNo guildId in config.json - cannot check guild commands');
    }
}

main().then(() => process.exit(0));
