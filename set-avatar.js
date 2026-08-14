const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const config = require('./config.json');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    try {
        const avatar = fs.readFileSync('./bot-avatar.png');
        await client.user.setAvatar(avatar);
        console.log('✅ Bot avatar updated successfully!');
        await client.user.setUsername('Xero Store');
        console.log('✅ Bot name updated to: Xero Store');
    } catch (e) {
        console.error('Failed to update avatar:', e.message);
    }
    process.exit(0);
});

client.login(config.token);
