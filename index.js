const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const http = require('http');

console.log('Starting Xero Store Bot...');

// ==================== CONFIG ====================
let config = {};
try { config = require('./config.json'); } catch (e) { console.log('config.json not found - using environment variables.'); }
config.token = process.env.TOKEN || process.env.DISCORD_TOKEN || config.token;
config.guildId = process.env.GUILD_ID || config.guildId || '';
config.ownerId = process.env.OWNER_ID || config.ownerId || '';
config.upiId = process.env.UPI_ID || config.upiId || '';
config.upiName = process.env.UPI_NAME || config.upiName || "Xero's Store";

// Auto-detect UPI from QR image
try {
    if (!config.upiId && fs.existsSync(path.join(__dirname, 'upi-qr.png'))) {
        const { PNG } = require('pngjs');
        const jsQR = require('jsqr');
        const png = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'upi-qr.png')));
        const code = jsQR(new Uint8ClampedArray(png.data.buffer), png.width, png.height);
        if (code && code.data.startsWith('upi://')) {
            const pa = new URLSearchParams(new URL(code.data).search).get('pa');
            const pn = new URLSearchParams(new URL(code.data).search).get('pn');
            if (pa) config.upiId = pa;
            if (pn) config.upiName = decodeURIComponent(pn);
            console.log('Auto-detected UPI: ' + config.upiId);
        }
    }
} catch (e) { console.log('QR auto-detect skipped: ' + e.message); }

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const STORE_NAME = "Xero's Store";

// ==================== DATA STORAGE ====================
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

function loadData(file) {
    const fp = path.join(dataDir, file);
    if (!fs.existsSync(fp)) return {};
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return {}; }
}

function saveData(file, data) {
    fs.writeFileSync(path.join(dataDir, file), JSON.stringify(data, null, 2));
}

// ==================== PERSISTENT ORDER COUNTER ====================
function getNextOrderNo() {
    const counter = loadData('counter.json');
    const next = (counter.orderCounter || 0) + 1;
    saveData('counter.json', { orderCounter: next });
    return next;
}

// ==================== UPI EMBED ====================
async function upiEmbed(upiId, amount, name, note) {
    if (!upiId) {
        return { 
            embed: new EmbedBuilder()
                .setTitle('💳 UPI Payment')
                .setDescription('❌ No UPI ID is set. Run `/setupi upiid:yourname@bank` first.')
                .setColor('#FF5555')
                .setFooter({ text: STORE_NAME }),
            file: null 
        };
    }
    const localQr = path.join(__dirname, 'upi-qr.png');
    const hasLocalQr = fs.existsSync(localQr);
    const params = new URLSearchParams();
    params.set('pa', upiId);
    params.set('pn', name || config.upiName || STORE_NAME);
    if (amount) params.set('am', amount);
    params.set('cu', 'INR');
    if (note) params.set('tn', note);
    const upiLink = 'upi://pay?' + params.toString();
    const qrUrl = hasLocalQr ? 'attachment://upi-qr.png' : 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=' + encodeURIComponent(upiLink);
    const embed = new EmbedBuilder()
        .setTitle('💳 UPI Payment Details')
        .setDescription('Scan the **QR code** below with any UPI app (GPay, PhonePe, Paytm, BHIM) or pay directly to the UPI ID.')
        .setImage(qrUrl)
        .addFields(
            { name: '🏦 UPI ID', value: '**' + upiId + '**', inline: true },
            { name: '👤 Payee', value: name || config.upiName || STORE_NAME, inline: true }
        )
        .setColor('#00E5FF')
        .setFooter({ text: STORE_NAME })
        .setTimestamp();
    if (amount) embed.addFields({ name: '💲 Amount', value: '₹' + amount, inline: true });
    if (note) embed.addFields({ name: '📝 Note', value: note, inline: true });
    embed.addFields({ name: '✅ After Payment', value: 'Reply with the **transaction ID (UTR/Txn No.)** here so staff can confirm your order instantly.' });
    return hasLocalQr ? { embed, file: localQr } : { embed, file: null };
}

// ==================== LEVELING SYSTEM ====================
function xpForLevel(level) { return 100 * level; }
function levelFromXp(xp) {
    let level = 0, remaining = xp;
    while (remaining >= xpForLevel(level + 1)) { remaining -= xpForLevel(level + 1); level++; }
    return { level, currentXp: remaining, xpNeeded: xpForLevel(level + 1) };
}

async function grantXp(member) {
    if (!member || member.user.bot) return;
    const levels = loadData('levels.json');
    const user = levels[member.id] || { xp: 0, level: 0, lastMsg: 0 };
    const now = Date.now();
    if (now - (user.lastMsg || 0) < 45000) return;
    user.lastMsg = now;
    user.xp += Math.floor(Math.random() * 8) + 4;
    const before = user.level;
    const info = levelFromXp(user.xp);
    user.level = info.level;
    levels[member.id] = user;
    saveData('levels.json', levels);
    if (info.level > before) {
        const levelUpChannel = member.guild.channels.cache.find(c => c.name === 'level-up');
        const embed = new EmbedBuilder()
            .setTitle('🎉 Level Up!')
            .setDescription('**' + member.user.tag + '** reached **Level ' + info.level + '**!')
            .setColor('#F1C40F')
            .setFooter({ text: STORE_NAME })
            .setTimestamp();
        if (levelUpChannel) await levelUpChannel.send({ content: 'Congrats <@' + member.id + '>! 🎊', embeds: [embed] });
        const levelRoleMap = { 5: 'Lv 5', 10: 'Lv 10', 25: 'Lv 25', 50: 'Lv 50', 100: 'Lv 100' };
        for (const [lv, roleName] of Object.entries(levelRoleMap)) {
            if (info.level >= parseInt(lv)) { 
                const role = member.guild.roles.cache.find(r => r.name === roleName);
                if (role && !member.roles.cache.has(role.id)) await member.roles.add(role).catch(() => {}); 
            }
        }
    }
}

async function assignVerifiedBuyer(guild, userId) {
    try {
        const role = guild.roles.cache.find(r => r.name === 'Verified');
        if (!role) return;
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member && !member.roles.cache.has(role.id)) await member.roles.add(role);
    } catch (e) {}
}

// ==================== ANTI-SCAM PROTECTION ====================
const SCAM_PATTERNS = [
    /free[ ]*nitro/i,
    /nitro[ ]*(?:gift|giveaway|boost).{0,20}(?:steam|discord[.]gift|dicsord|dlscord|discorcl)/i,
    /discord[.]gift(?:[^a-z]|$)/i,
    /(?:dicsord|dlscord|discorcl|discrod|disc0rd)[.]/i,
    /steamcommunity[.]com[^"]*free/i,
    /(?:paypal|venmo)[^@]{0,20}@[a-z]+[.][a-z]{2,}/i,
    /[=][^ ]{12,}={1,2}$/i
];
const SCAM_WORDS = ['free nitro', 'nitro gift', 'discord gift', 'steam gift', 'nitro boost free', 'gift link', 'giftcard giveaway'];

async function antiScamCheck(message) {
    const text = message.content;
    if (!text) return false;
    // Skip #vouches channel - vouches mentioning "free" are legit
    const vouchCh = message.guild?.channels?.cache?.find(c => c.name === 'vouches');
    if (vouchCh && message.channel.id === vouchCh.id) return false;
    // Skip staff messages
    if (message.member?.roles?.cache?.some(r => ['Owner', 'Admin', 'Staff'].includes(r.name))) return false;
    // Mass mention spam - only if combined with scam words AND short message
    if (message.mentions.everyone && text.length < 100) { 
        const hasScam = SCAM_WORDS.some(w => text.toLowerCase().includes(w)); 
        if (hasScam) return true; 
    }
    if (message.mentions.users.size > 10) { 
        const hasScam = SCAM_WORDS.some(w => text.toLowerCase().includes(w)); 
        if (hasScam) return true; 
    }
    for (const pat of SCAM_PATTERNS) { if (pat.test(text)) return true; }
    for (const w of SCAM_WORDS) { if (text.toLowerCase().includes(w)) return true; }
    return false;
}

// ==================== REPLACE EMBED (IMPROVED) ====================
async function replaceEmbed(channel, title, newEmbed, row) {
    try {
        const messages = await channel.messages.fetch({ limit: 100 });
        // Only delete THIS bot's messages (not other bots)
        const oldMessages = messages.filter(m => m.author.id === client.user.id && m.embeds.some(e => e.title === title));
        if (oldMessages.size > 0) {
            const newest = oldMessages.first();
            const oldJson = JSON.stringify(newest.embeds[0]?.toJSON());
            const newJson = JSON.stringify(newEmbed.toJSON());
            if (oldJson === newJson && oldMessages.size <= 1) {
                return; // content identical
            }
            // Delete individually to handle messages >14 days old
            for (const [key, msg] of oldMessages) {
                await msg.delete().catch(() => {});
            }
            console.log(`Refreshed embed in #${channel.name}: ${title}`);
        }
        await channel.send({ embeds: [newEmbed], components: row ? [row] : undefined });
    } catch (e) {
        // Fallback: just send if we can't read history
        await channel.send({ embeds: [newEmbed], components: row ? [row] : undefined }).catch(() => {});
    }
}

// ==================== GIVEAWAY ====================
async function endGiveaway(gId, guild, channel, msg) {
    try {
        const giveaways = loadData('giveaways.json');
        const ga = giveaways[gId];
        if (!ga) return;
        delete giveaways[gId];
        saveData('giveaways.json', giveaways);
        // Use entrants array from JSON (button entries preserved)
        let entrants = [...new Set(ga.entrants || [])];
        const winnerIds = [];
        const pool = [...entrants];
        for (let i = 0; i < Math.min(ga.winners, pool.length); i++) {
            const idx = Math.floor(Math.random() * pool.length);
            winnerIds.push(pool.splice(idx, 1)[0]);
        }
        const resultEmbed = new EmbedBuilder()
            .setTitle('🎉 Giveaway Ended!')
            .setDescription('**Prize:** ' + ga.prize)
            .setColor('#FF69B4')
            .setFooter({ text: STORE_NAME })
            .setTimestamp();
        if (winnerIds.length > 0) {
            resultEmbed.addFields({
                name: '🏆 Winners',
                value: winnerIds.map(id => '<@' + id + '>').join(', ')
            });
            await channel.send({ 
                content: winnerIds.map(id => '<@' + id + '>').join(' ') + ' congratulations! 🎉', 
                embeds: [resultEmbed] 
            });
        } else {
            resultEmbed.setDescription('**Prize:** ' + ga.prize + '/n/nNo one entered. 😢');
            await channel.send({ embeds: [resultEmbed] });
        }
    } catch (e) {
        console.error('Giveaway end error:', e.message);
    }
}

// ==================== SERVER SETUP ====================
async function setupServer(guild) {
    console.log('Setting up: ' + guild.name);
    const setupState = loadData('setup-state.json');

    // Create roles (skip if exists)
    const roleList = [
        { name: 'Owner', color: '#FF0000', permissions: [PermissionBits.Flags.Administrator] },
        { name: 'Admin', color: '#FF5555', permissions: [PermissionBits.Flags.ManageGuild, PermissionBits.Flags.BanMembers, PermissionBits.Flags.KickMembers, PermissionBits.Flags.ManageMessages] },
        { name: 'Staff', color: '#FF8800', permissions: [PermissionBits.Flags.ManageMessages, PermissionBits.Flags.ModerateMembers] },
        { name: 'Seller', color: '#00C853', permissions: [] },
        { name: 'Buyer', color: '#0099FF', permissions: [] },
        { name: 'Verified', color: '#00E5FF', permissions: [] },
        { name: 'Trusted', color: '#FFD700', permissions: [] },
        { name: 'Member', color: '#808080', permissions: [] }
    ];
    for (const r of roleList) {
        if (!guild.roles.cache.find(x => x.name === r.name)) {
            await guild.roles.create({ name: r.name, color: r.color, permissions: r.permissions }).catch(() => {});
        }
    }

    // Fetch fresh channels
    await guild.channels.fetch().catch(() => {});

    // Create categories + channels (skip existing)
    const cats = [
        { name: 'INFO', ch: ['announce', 'rules', 'events', 'giveaway'] },
        { name: 'SHOPS', ch: ['restock', 'restock-2', 'game-acc', 'pc-parts'] },
        { name: 'LEGITNESS', ch: ['proofs', 'vouches', 'orders'] },
        { name: 'MEMBERS', ch: ['general-chat', 'welcome-back', 'introduce', 'level-up', 'feedback', 'mirrors', 'backups'] },
        { name: 'SUPPORT', ch: ['create-ticket', 'ticket-logs'] }
    ];
    for (const cat of cats) {
        let catObj = guild.channels.cache.find(c => c.name.includes(cat.name) && c.type === ChannelType.GuildCategory);
        if (!catObj) {
            catObj = await guild.channels.create({ name: STORE_NAME + ' ' + cat.name, type: ChannelType.GuildCategory }).catch(() => null);
        }
        if (!catObj) continue;
        for (const chName of cat.ch) {
            if (!guild.channels.cache.find(c => c.name === chName)) {
                await guild.channels.create({ name: chName, type: ChannelType.GuildText, parent: catObj.id }).catch(() => {});
            }
        }
    }

    // Voice channels
    let voiceCat = guild.channels.cache.find(c => c.name.includes('VOICE') && c.type === ChannelType.GuildCategory);
    if (!voiceCat) voiceCat = await guild.channels.create({ name: STORE_NAME + ' VOICE', type: ChannelType.GuildCategory }).catch(() => null);
    if (voiceCat) {
        if (!guild.channels.cache.find(c => c.name === 'General Voice')) await guild.channels.create({ name: 'General Voice', type: ChannelType.GuildVoice, parent: voiceCat.id }).catch(() => {});
        if (!guild.channels.cache.find(c => c.name === 'Buyers Chat')) await guild.channels.create({ name: 'Buyers Chat', type: ChannelType.GuildVoice, parent: voiceCat.id }).catch(() => {});
    }

    // Read-only permissions (except general-chat, vouches)
    const openCh = new Set(['general-chat', 'vouches']);
    const staff = guild.roles.cache.find(r => r.name === 'Admin');
    for (const ch of guild.channels.cache.values()) {
        if (ch.type === ChannelType.GuildCategory || ch.type === ChannelType.GuildVoice) continue;
        if (openCh.has(ch.name) || /^order-|^support-|^ticket-/.test(ch.name)) continue;
        await ch.permissionOverwrites.edit(guild.id, { SendMessages: false, AddReactions: false }).catch(() => {});
        if (staff) await ch.permissionOverwrites.edit(staff.id, { SendMessages: true, AddReactions: true, ManageMessages: true }).catch(() => {});
    }

    // Ticket embed
    const ticketCh = guild.channels.cache.find(c => c.name === 'create-ticket');
    if (ticketCh) {
        try { 
            const old = await ticketCh.messages.fetch({ limit: 50 }); 
            for (const [, m] of old.filter(x => x.author.id === client.user.id)) await m.delete().catch(() => {}); 
        } catch (e) {}
        const embed = new EmbedBuilder()
            .setTitle('Orders & Support')
            .setDescription('Click a button below:/n/nPlace Order - Buy a product/n/nSupport - Get help with a problem')
            .setColor('#0099FF')
            .setFooter({ text: STORE_NAME });
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('place_order').setLabel('Place Order').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('support_ticket').setLabel('Support').setStyle(ButtonStyle.Primary)
        );
        await ticketCh.send({ embeds: [embed], components: [row] }).catch(() => {});
    }

    setupState[guild.id] = Date.now();
    saveData('setup-state.json', setupState);
    console.log('Setup complete!');
}

// ==================== SLASH COMMANDS ====================
const commands = [
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Setup server (Admin only)'),
    new SlashCommandBuilder()
        .setName('afk')
        .setDescription('Set AFK status')
        .addStringOption(o => o.setName('reason').setDescription('Why are you AFK?').setRequired(false)),
    new SlashCommandBuilder()
        .setName('earnings')
        .setDescription('View store earnings (Staff only)'),
    new SlashCommandBuilder()
        .setName('blacklist')
        .setDescription('Blacklist a user from creating tickets (Staff only)')
        .addUserOption(o => o.setName('user').setDescription('User to blacklist').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder()
        .setName('unblacklist')
        .setDescription('Remove user from blacklist')
        .addUserOption(o => o.setName('user').setDescription('User to unblacklist').setRequired(true)),
    new SlashCommandBuilder()
        .setName('product')
        .setDescription('Post a product')
        .addStringOption(o => o.setName('description').setDescription('Full product listing').setRequired(true).setMaxLength(4000))
        .addStringOption(o => o.setName('channel').setDescription('restock, game-acc, etc').setRequired(false)),
    new SlashCommandBuilder()
        .setName('stock')
        .setDescription('View all products'),
    new SlashCommandBuilder()
        .setName('orders')
        .setDescription('Check your orders'),
    new SlashCommandBuilder()
        .setName('confirm')
        .setDescription('Confirm order (Staff)')
        .addIntegerOption(o => o.setName('orderno').setDescription('Order number').setRequired(true)),
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show all commands'),
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Show store stats'),
    new SlashCommandBuilder()
        .setName('upi')
        .setDescription('Show UPI scanner')
        .addIntegerOption(o => o.setName('amount').setDescription('Amount in ₹').setRequired(true)),
    new SlashCommandBuilder()
        .setName('announcement')
        .setDescription('Send announcement (Staff only)')
        .addChannelOption(o => o.setName('channel').setDescription('Target channel (default: announce)').setRequired(false)),
    new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Start giveaway (Staff only)')
        .addStringOption(o => o.setName('prize').setDescription('Prize').setRequired(true))
        .addIntegerOption(o => o.setName('hours').setDescription('Duration in hours').setRequired(true))
        .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setRequired(false)),
    new SlashCommandBuilder()
        .setName('setupi')
        .setDescription('Set UPI ID (Staff only)')
        .addStringOption(o => o.setName('upiid').setDescription('Your UPI ID').setRequired(true))
        .addStringOption(o => o.setName('name').setDescription('Payee name').setRequired(false)),
    new SlashCommandBuilder()
        .setName('lock')
        .setDescription('Lock channel')
        .addChannelOption(o => o.setName('channel').setDescription('Channel').required(false)),
    new SlashCommandBuilder()
        .setName('unlock')
        .setDescription('Unlock channel')
        .addChannelOption(o => o.setName('channel').setDescription('Channel').required(false)),
    new SlashCommandBuilder()
        .setName('slowmode')
        .setDescription('Set slowmode')
        .addIntegerOption(o => o.setName('seconds').setDescription('Delay (0 to disable)').required(true))
        .addChannelOption(o => o.setName('channel').setDescription('Channel').required(false)),
    new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick member')
        .addUserOption(o => o.setName('user').setDescription('User').required(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason').required(false)),
    new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban member')
        .addUserOption(o => o.setName('user').setDescription('User').required(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason').required(false)),
    new SlashCommandBuilder()
        .setName('mute')
        .setDescription('Timeout member')
        .addUserOption(o => o.setName('user').setDescription('User').required(true))
        .addIntegerOption(o => o.setName('minutes').setDescription('Duration').required(false))
        .addStringOption(o => o.setName('reason').setDescription('Reason').required(false)),
    new SlashCommandBuilder()
        .setName('unmute')
        .setDescription('Remove timeout')
        .addUserOption(o => o.setName('user').setDescription('User').required(true)),
    new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Bulk delete')
        .addIntegerOption(o => o.setName('count').setDescription('Count (max 100)').required(true))
];

async function registerCommands(guild) {
    const rest = new REST({ version: '10' }).setToken(config.token);
    try {
        console.log('Registering slash commands...');
        // Register per-guild for instant availability
        if (guild) {
            await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
        }
        // Also register globally (takes up to 1 hour)
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Slash commands registered!');
    } catch (e) {
        console.error('Failed to register commands:', e.message);
    }
}

// ==================== READY ====================
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Servers: ${client.guilds.cache.size}`);
    
    // Register commands on all guilds
    for (const guild of client.guilds.cache.values()) {
        await registerCommands(guild);
    }
    
    // Auto-assign Verified Buyer role to anyone who has vouches
    const vouchData = loadData('vouches.json');
    for (const [userId, data] of Object.entries(vouchData)) {
        if (!data.reviews || data.reviews.length === 0) continue;
        for (const g of client.guilds.cache.values()) {
            try {
                const member = await g.members.fetch(userId);
                if (member) {
                    const verifiedRole = g.roles.cache.find(r => r.name === 'Verified');
                    if (verifiedRole && !member.roles.cache.has(verifiedRole.id)) { 
                        await member.roles.add(verifiedRole); 
                        console.log('Assigned Verified to ' + member.user.tag);
                    }
                }
            } catch (e) {}
        }
    }
    
    client.user.setActivity(STORE_NAME + ' | /help', { type: 'Watching' });
});

// ==================== SLASH COMMANDS HANDLER ====================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;
    const { commandName } = interaction;
    if (!interaction.inGuild() && commandName !== 'upi') return interaction.reply({ content: '❌ Server only!', ephemeral: true });
    try {
        switch (commandName) {
            case 'setup': {
                if (!interaction.member.permissions.has(PermissionBits.Flags.Administrator)) {
                    return interaction.reply({ content: '❌ You need Administrator permission!', ephemeral: true });
                }
                await interaction.deferReply({ ephemeral: true });
                try {
                    await setupServer(interaction.guild);
                    await registerCommands(interaction.guild);
                    await interaction.editReply({ content: '✅ Server setup complete!' });
                } catch (e) {
                    console.error('Setup error:', e);
                    await interaction.editReply({ content: '⚠️ Setup completed with some errors.' }).catch(() => {});
                }
                break;
            }
            case 'afk': {
                const afkData = loadData('afk.json');
                const afkReason = interaction.options.getString('reason') || 'AFK';
                afkData[interaction.user.id] = {
                    reason: afkReason,
                    setAt: Date.now(),
                    setAtIso: new Date().toISOString()
                };
                saveData('afk.json', afkData);
                await interaction.reply({ content: '✅ You are now AFK: **' + afkReason + '**', ephemeral: true });
                break;
            }
            case 'earnings': {
                const isStaffEarn = interaction.member?.roles.cache.some(r => ['Owner', 'Admin', 'Staff'].includes(r.name)) ||
                    interaction.member.permissions.has(PermissionBits.Flags.Administrator);
                if (!isStaffEarn) return interaction.reply({ content: '❝ Staff only!', ephemeral: true });
                
                const orders = loadData('orders.json');
                const allOrders = Object.values(orders);
                const completed = allOrders.filter(o => o.status && o.status.includes('Completed'));
                const pending = allOrders.filter(o => o.status && o.status.includes('Pending'));
                
                let totalRevenue = 0;
                completed.forEach(o => {
                    if (o.price && o.price !== 'TBD' && o.price !== 'N/A') {
                        const num = parseFloat(String(o.price).replace(/[^0-9.]/g, ''));
                        if (!isNaN(num)) totalRevenue += num;
                    }
                });
                
                const today = new Date().toDateString();
                const todayOrders = completed.filter(o => {
                    if (!o.completedAt && !o.createdAt) return false;
                    return new Date(o.completedAt || o.createdAt).toDateString() === today;
                });
                
                const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
                const weekOrders = completed.filter(o => {
                    const d = new Date(o.completedAt || o.createdAt).getTime();
                    return d > weekAgo;
                });
                
                const productCount = {};
                completed.forEach(o => {
                    const p = o.product || 'Unknown';
                    productCount[p] = (productCount[p] || 0) + 1;
                });
                const topProducts = Object.entries(productCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
                
                const embed = new EmbedBuilder()
                    .setTitle('📊 ' + STORE_NAME + ' Earnings')
                    .setColor('#00E5FF')
                    .setFooter({ text: STORE_NAME })
                    .setTimestamp()
                    .addFields(
                        { name: '💰 Total Revenue', value: '₹' + totalRevenue.toFixed(2), inline: true },
                        { name: '✅ Completed', value: '' + completed.length, inline: true },
                        { name: '⏳ Pending', value: '' + pending.length, inline: true },
                        { name: '📅 Today', value: '' + todayOrders.length + ' orders', inline: true },
                        { name: '📆 This Week', value: '' + weekOrders.length + ' orders', inline: true },
                        { name: '🛒 Total Orders', value: '' + allOrders.length, inline: true }
                    );
                
                if (topProducts.length > 0) {
                    embed.addFields({
                        name: '🏆 Top Products',
                        value: topProducts.map(([name, count], i) => (i + 1) + '. ' + name.slice(0, 25) + ' (' + count + ' sales)').join('/n')
                    });
                }
                
                await interaction.reply({ embeds: [embed], ephemeral: true });
                break;
            }
            case 'blacklist': {
                const isStaffBl = interaction.member?.roles.cache.some(r => ['Owner', 'Admin', 'Staff'].includes(r.name)) ||
                    interaction.member.permissions.has(PermissionBits.Flags.Administrator);
                if (!isStaffBl) return interaction.reply({ content: '❝ Staff only!', ephemeral: true });
                
                const blTarget = interaction.options.getUser('user');
                const blReason = interaction.options.getString('reason') || 'No reason';
                const blacklist = loadData('blacklist.json');
                
                if (blacklist[blTarget.id]) {
                    return interaction.reply({ content: '❝ ' + blTarget.tag + ' is already blacklisted!', ephemeral: true });
                }
                
                blacklist[blTarget.id] = {
                    tag: blTarget.tag,
                    reason: blReason,
                    blacklistedBy: interaction.user.id,
                    blacklistedAt: new Date().toISOString()
                };
                saveData('blacklist.json', blacklist);
                await interaction.reply({ content: '🚫 **' + blTarget.tag + '** blacklisted./nReason: ' + blReason, ephemeral: true });
                break;
            }
            
            case 'unblacklist': {
                const isStaffUbl = interaction.member?.roles.cache.some(r => ['Owner', 'Admin', 'Staff'].includes(r.name)) ||
                    interaction.member.permissions.has(PermissionBits.Flags.Administrator);
                if (!isStaffUbl) return interaction.reply({ content: '❝ Staff only!', ephemeral: true });
                
                const ublTarget = interaction.options.getUser('user');
                const blacklist = loadData('blacklist.json');
                
                if (!blacklist[ublTarget.id]) {
                    return interaction.reply({ content: '❝ ' + ublTarget.tag + ' is not blacklisted.', ephemeral: true });
                }
                
                delete blacklist[ublTarget.id];
                saveData('blacklist.json', blacklist);
                await interaction.reply({ content: '✅ **' + ublTarget.tag + '** removed from blacklist.', ephemeral: true });
                break;
            }
            
            case 'product': {
                if (!interaction.member.roles.cache.find(r => ['Seller', 'Admin', 'Owner', 'Staff'].includes(r.name))) {
                    return interaction.reply({ content: '❝ You need the Seller role to add products!', ephemeral: true });
                }
                const channelName = interaction.options.getString('channel') || interaction.channel?.name || 'restock';
                
                const modal = new ModalBuilder()
                    .setCustomId('product_modal_' + channelName)
                    .setTitle('Post Product');
                
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('product_desc')
                        .setLabel('Paste your product listing')
                        .setStyle(TextInputStyle.Paragraph)
                        .setPlaceholder('Paste your full formatted product text here...')
                        .setRequired(true)
                        .setMaxLength(4000)
                ));
                
                await interaction.showModal(modal);
                break;
            }
            
            case 'stock': {
                const products = loadData('products.json');
                const list = Object.entries(products);
                if (list.length === 0) return interaction.reply({ content: 'No products listed yet.', ephemeral: true });
                
                const embed = new EmbedBuilder()
                    .setTitle('🛒 ' + STORE_NAME + ' Stock')
                    .setColor('#00C853')
                    .setFooter({ text: STORE_NAME });
                
                list.forEach(([id, p]) => {
                    embed.addFields({ 
                        name: `${p.name || 'Product'} - ${p.price || ''}`, 
                        value: `${(p.description || '').slice(0, 100)}/nSeller: <@${p.seller}>`, 
                        inline: false 
                    });
                });
                
                await interaction.reply({ embeds: [embed], ephemeral: true });
                break;
            }
            
            case 'orders': {
                const orders = loadData('orders.json');
                const userOrders = Object.values(orders).filter(o => o.buyer === interaction.user.id);
                if (userOrders.length === 0) return interaction.reply({ content: 'You have no orders yet.', ephemeral: true });
                
                const embed = new EmbedBuilder()
                    .setTitle('🧾 Your Orders')
                    .setColor('#FF8800')
                    .setFooter({ text: STORE_NAME });
                
                userOrders.slice(5).reverse().forEach(o => {
                    embed.addFields({
                        name: `Order #${o.orderNo} - ${o.status}`,
                        value: `${o.product} x${o.quantity}/nPrice: ${o.price || 'TBD'}`
                    });
                });
                
                await interaction.reply({ embeds: [embed], ephemeral: true });
                break;
            }
            
            case 'confirm': {
                if (!interaction.member.roles.cache.find(r => ['Owner', 'Admin', 'Staff', 'Seller'].includes(r.name))) {
                    return interaction.reply({ content: '❝ Staff only!', ephemeral: true });
                }
                const orderNo = interaction.options.getInteger('orderno');
                const orders = loadData('orders.json');
                const order = Object.values(orders).find(o => o.orderNo === orderNo);
                if (!order) return interaction.reply({ content: '❝ Order not found!', ephemeral: true });
                
                order.status = '✅ Completed';
                order.confirmedBy = interaction.user.id;
                order.confirmedAt = new Date().toISOString();
                saveData('orders.json', orders);
                
                const ordersChannel = interaction.guild.channels.cache.find(c => c.name === 'orders');
                if (ordersChannel) {
                    const embed = new EmbedBuilder()
                        .setTitle('✅ Order Confirmed')
                        .setDescription('**Order No:** ' + order.orderNo + '/n**Product:** ' + order.product + '/n**Quantity:** ' + (order.quantity || 1) + '/n**Buyer:** <@' + order.buyer + '>')
                        .setColor('#00C853')
                        .setFooter({ text: STORE_NAME })
                        .setTimestamp();
                    await ordersChannel.send({ embeds: [embed] });
                }
                
                await interaction.reply({ content: '✅ Order #' + orderNo + ' confirmed!', ephemeral: true });
                break;
            }
            
            case 'help': {
                const embed = new EmbedBuilder()
                    .setTitle('📚 ' + STORE_NAME + ' Commands')
                    .setColor('#0099FF')
                    .addFields(
                        { name: '/setup', value: 'Setup server (Admin)' },
                        { name: '/afk', value: 'Set AFK status' },
                        { name: '/earnings', value: 'View earnings (Staff only)' },
                        { name: '/blacklist', value: 'Blacklist a user (Staff only)' },
                        { name: '/unblacklist', value: 'Remove from blacklist' },
                        { name: '/product', value: 'Add product (Seller)' },
                        { name: '/stock', value: 'View all products' },
                        { name: '/orders', value: 'Check your orders' },
                        { name: '/confirm <orderno>', value: 'Confirm order (Staff)' },
                        { name: '/help', value: 'Show this menu' },
                        { name: '/stats', value: 'Show store stats' },
                        { name: '/stats', value: 'Show store stats' },
                        { name: '/upi', value: 'Show UPI scanner' },
                        { name: '/announcement', value: 'Send announcement (Staff only)' },
                        { name: '/giveaway', value: 'Start giveaway (Staff only)' },
                        { name: '/setupi', value: 'Set UPI ID (Staff only)' },
                        { name: '/lock', value: 'Lock channel' },
                        { name: '/unlock', value: 'Unlock channel' },
                        { name: '/slowmode', value: 'Set slowmode' },
                        { name: '/kick', value: 'Kick member' },
                        { name: '/ban', value: 'Ban member' },
                        { name: '/mute', value: 'Timeout member' },
                        { name: '/unmute', value: 'Remove timeout' },
                        { name: '/purge', value: 'Bulk delete' }
                    )
                    .setFooter({ text: STORE_NAME });
                await interaction.reply({ embeds: [embed], ephemeral: true });
                break;
            }
            
            case 'stats': {
                const vouches = loadData('vouches.json');
                const orders = loadData('orders.json');
                const products = loadData('products.json');
                const totalVouches = Object.values(vouches).reduce((a, b) => a + (b.count || 0), 0);
                const embed = new EmbedBuilder()
                    .setTitle('📊 ' + STORE_NAME + ' Stats')
                    .addFields(
                        { name: '🛒 Products', value: '' + Object.keys(products).length, inline: true },
                        { name: '🧾 Orders', value: '' + Object.keys(orders).length, inline: true },
                        { name: '⭐ Vouches', value: '' + totalVouches, inline: true },
                        { name: '👥 Members', value: '' + interaction.guild.memberCount, inline: true }
                    )
                    .setColor('#00E5FF')
                    .setFooter({ text: STORE_NAME });
                await interaction.reply({ embeds: [embed], ephemeral: true });
                break;
            }
            
            case 'upi': {
                const amount = String(interaction.options.getInteger('amount'));
                let autoNote = null;
                if (/^order-/.test(interaction.channel?.name || '')) {
                    autoNote = 'Order ' + interaction.channel.name.replace('order-', '#');
                }
                
                const { embed, file } = await upiEmbed(config.upiId, amount, config.upiName, autoNote);
                const payload = file ? { embeds: [embed], files: [file] } : { embeds: [embed] };
                await interaction.reply(payload);
                break;
            }
            
            case 'setupi': {
                if (!interaction.member?.roles?.cache?.some(r => ['Owner', 'Admin', 'Staff'].includes(r.name))) {
                    return interaction.reply({ content: '❝ Staff only!', ephemeral: true });
                }
                config.upiId = interaction.options.getString('upiid');
                if (interaction.options.getString('name')) config.upiName = interaction.options.getString('name');
                try {
                    const cfgPath = path.join(__dirname, 'config.json');
                    let cfg = {};
                    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {}
                    cfg.upiId = config.upiId;
                    cfg.upiName = config.upiName;
                    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
                    await interaction.reply({ content: '✅ UPI ID set to **' + config.upiId + '**!', ephemeral: true });
                } catch (e) {
                    await interaction.reply({ content: '✅ UPI ID set for this session: **' + config.upiId + '** (could not save to config.json)', ephemeral: true });
                }
                break;
            }
            
            case 'giveaway': {
                if (!interaction.member?.roles?.cache?.some(r => ['Owner', 'Admin', 'Staff'].includes(r.name))) {
                    return interaction.reply({ content: '❝ Staff only!', ephemeral: true });
                }
                const prize = interaction.options.getString('prize');
                const hours = interaction.options.getInteger('hours');
                const winners = interaction.options.getInteger('winners') || 1;
                const endTime = Date.now() + hours * 3600000;
                
                const giveawayEmbed = new EmbedBuilder()
                    .setTitle('🎉 GIVEAWAY!')
                    .setDescription('**Prize:** ' + prize + '/n/nClick the **🎉 Enter** button below to join!/n**Winners:** ' + winners + '/n**Ends:** <t:' + Math.floor(endTime / 1000) + ':R>')
                    .setColor('#FF69B4')
                    .setFooter({ text: STORE_NAME })
                    .setTimestamp();
                
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('enter_giveaway').setLabel('🎉 Enter').setStyle(ButtonStyle.Success)
                );
                
                const channel = interaction.guild.channels.cache.find(c => c.name === 'giveaway') || interaction.channel;
                const msg = await channel.send({ content: '@everyone 🎁', embeds: [giveawayEmbed], components: [row] });
                
                const giveaways = loadData('giveaways.json');
                giveaways[msg.id] = {
                    prize, winners, endTime,
                    channelId: channel.id,
                    hostId: interaction.user.id,
                    entrants: []
                };
                saveData('giveaways.json', giveaways);
                
                await interaction.reply({ content: '🎉 Giveaway started in ' + channel + '!', ephemeral: true });
                
                setTimeout(() => endGiveaway(msg.id, interaction.guild, channel, msg), hours * 3600000);
                break;
            }
            
            case 'lock': {
                if (!interaction.member.permissions.has(PermissionBits.Flags.ManageChannels)) {
                    return interaction.reply({ content: '❝ You need Manage Channels permission!', ephemeral: true });
                }
                const ch = interaction.options.getChannel('channel') || interaction.channel;
                await ch.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false });
                await interaction.reply({ content: '🔒 Locked ' + ch, ephemeral: true });
                break;
            }
            
            case 'unlock': {
                if (!interaction.member.permissions.has(PermissionBits.Flags.ManageChannels)) {
                    return interaction.reply({ content: '❝ You need Manage Channels permission!', ephemeral: true });
                }
                const ch = interaction.options.getChannel('channel') || interaction.channel;
                await ch.permissionOverwrites.edit(interaction.guild.id, { SendMessages: true });
                await interaction.reply({ content: '🔓 Unlocked ' + ch, ephemeral: true });
                break;
            }
            
            case 'slowmode': {
                if (!interaction.member.permissions.has(PermissionBits.Flags.ManageChannels)) {
                    return interaction.reply({ content: '❝ You need Manage Channels permission!', ephemeral: true });
                }
                const ch = interaction.options.getChannel('channel') || interaction.channel;
                const sec = Math.min(interaction.options.getInteger('seconds'), 21600);
                await ch.setRateLimitPerUser(sec);
                await interaction.reply({ content: '🐌 Slowmode: ' + sec + 's in ' + ch, ephemeral: true });
                break;
            }
            
            case 'kick': {
                if (!interaction.member.permissions.has(PermissionBits.Flags.KickMembers)) {
                    return interaction.reply({ content: '❝ You need Kick Members permission!', ephemeral: true });
                }
                const target = interaction.options.getMember('user');
                const reason = interaction.options.getString('reason') || 'No reason';
                if (!target) return interaction.reply({ content: '❝ You not found in this server!', ephemeral: true });
                if (!target.kickable) return interaction.reply({ content: '❝ I cannot kick this user!', ephemeral: true });
                await target.kick(reason);
                await interaction.reply({ content: '👢 Kicked ' + target.user.tag + ' | ' + reason, ephemeral: true });
                break;
            }
            
            case 'ban': {
                if (!interaction.member.permissions.has(PermissionBits.Flags.BanMembers)) {
                    return interaction.reply({ content: '❝ You need Ban Members permission!', ephemeral: true });
                }
                const target = interaction.options.getMember('user');
                const reason = interaction.options.getString('reason') || 'No reason';
                if (!target) return interaction.reply({ content: '❝ You not found in this server!', ephemeral: true });
                if (!target.bannable) return interaction.reply({ content: '❝ I cannot ban this user!', ephemeral: true });
                await target.ban({ reason });
                await interaction.reply({ content: '🔨 Banned ' + target.user.tag + ' | ' + reason, ephemeral: true });
                break;
            }
            
            case 'mute': {
                if (!interaction.member.permissions.has(PermissionBits.Flags.ModerateMembers)) {
                    return interaction.reply({ content: '❝ You need Moderate Members permission!', ephemeral: true });
                }
                const target = interaction.options.getMember('user');
                const mins = interaction.options.getInteger('minutes') || 10;
                const reason = interaction.options.getString('reason') || 'No reason';
                if (!target) return interaction.reply({ content: '❝ You not found in this server!', ephemeral: true });
                if (!target.moderatable) return interaction.reply({ content: '❝ I cannot mute this user!', ephemeral: true });
                await target.timeout(mins * 60000, reason);
                await interaction.reply({ content: '🔇 Muted ' + target.user.tag + ' for ' + mins + 'min | ' + reason, ephemeral: true });
                break;
            }
            
            case 'unmute': {
                if (!interaction.member.permissions.has(PermissionBits.Flags.ModerateMembers)) {
                    return interaction.reply({ content: '❝ You need Moderate Members permission!', ephemeral: true });
                }
                const target = interaction.options.getMember('user');
                if (!target) return interaction.reply({ content: '❝ You not found in this server!', ephemeral: true });
                await target.timeout(null);
                await interaction.reply({ content: '🔊 Unmuted ' + target.user.tag, ephemeral: true });
                break;
            }
            
            case 'purge': {
                if (!interaction.member.permissions.has(PermissionBits.Flags.ManageMessages)) {
                    return interaction.reply({ content: '❝ You need Manage Messages permission!', ephemeral: true });
                }
                const count = Math.min(interaction.options.getInteger('count'), 100);
                if (count < 1) return interaction.reply({ content: '❝ Must delete at least 1 message!', ephemeral: true });
                await interaction.deferReply({ ephemeral: true });
                const deleted = await interaction.channel.bulkDelete(count, true);
                await interaction.editReply({ content: '🗑️ Deleted ' + deleted.size + ' messages.' });
                break;
            }
        }
    } catch (err) {
        console.error('Command error:', err);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ Error occurred!', ephemeral: true });
        }
    }
});

// ==================== BUTTON & MODAL HANDLERS ====================
client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
        // Place Order
        if (interaction.customId === 'place_order') {
            // BLACKLIST CHECK
            const blacklist = loadData('blacklist.json');
            if (blacklist[interaction.user.id]) {
                return interaction.reply({ 
                    content: '❝ You are blacklisted from creating tickets./nReason: ' + (blacklist[interaction.user.id].reason || 'N/A'), 
                    ephemeral: true 
                });
            }
            
            const modal = new ModalBuilder()
                .setCustomId('order_modal')
                .setTitle('🛒 Place Order');
            
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('order_product')
                        .setLabel('Product (e.g. Nitro Boost, Crunchyroll 6m)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('order_qty')
                        .setLabel('Quantity')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('order_price')
                        .setLabel('Offer / Budget')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('order_notes')
                        .setLabel('Notes (payment method, details)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(false)
                )
            );
            
            await interaction.showModal(modal);
        }
        
        // Support ticket
        if (interaction.customId === 'support_ticket') {
            // BLACKLIST CHECK
            const blacklist = loadData('blacklist.json');
            if (blacklist[interaction.user.id]) {
                return interaction.reply({ 
                    content: '❝ You are blacklisted from creating tickets./nReason: ' + (blacklist[interaction.user.id].reason || 'N/A'), 
                    ephemeral: true 
                });
            }
            
            const ticketChannel = await guild.channels.create({
                name: `support-${interaction.user.username}`,
                type: ChannelType.GuildText,
                parent: interaction.guild.channels.cache.find(c => c.name.includes('SUPPORT'))?.id,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionBits.Flags.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionBits.Flags.ViewChannel, PermissionBits.Flags.SendMessages, PermissionBits.Flags.ReadMessageHistory] }
                ]
            });
            
            const embed = new EmbedBuilder()
                .setTitle('🎧 Support Ticket')
                .setDescription(`Ticket created by ${interaction.user}/n/nDescribe your issue. Staff will help shortly.`)
                .setColor('#0099FF')
                .setFooter({ text: STORE_NAME });
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
            );
            
            await ticketChannel.send({ content: `<@${interaction.user.id}>`, embeds: [embed], components: [row] });
            await interaction.reply({ content: `Ticket created: ${ticketChannel}`, ephemeral: true });
        }
        
        // Close ticket - Admin/Owner only
        if (interaction.customId === 'close_ticket') {
            const isStaffClose = interaction.member.roles.cache.some(r => ['Owner', 'Admin'].includes(r.name)) ||
                interaction.member.permissions.has(PermissionBits.Flags.Administrator);
            if (!isStaffClose) {
                return interaction.reply({ content: '❝ Only Admins or Owner can close tickets!', ephemeral: true });
            }
            
            const embed = new EmbedBuilder()
                .setTitle('🔒 Ticket Closed')
                .setDescription(`Closed by ${interaction.user.tag}`)
                .setColor('#FF5555')
                .setFooter({ text: STORE_NAME });
            
            const logChannel = interaction.guild.channels.cache.find(c => c.name === 'ticket-logs');
            if (logChannel) await logChannel.send({ embeds: [embed] });
            await interaction.reply({ content: '🔒 Closing ticket...' });
            await interaction.channel.delete();
        }
        
        // Buy product button
        if (interaction.customId.startsWith('buy_')) {
            const productId = interaction.customId.replace('buy_', '');
            const products = loadData('products.json');
            const product = products[productId];
            if (!product) return interaction.reply({ content: '❝ Product not found!', ephemeral: true });
            
            const orderNo = getNextOrderNo();
            const orders = loadData('orders.json');
            const orderId = 'order_' + orderNo;
            orders[orderId] = {
                orderNo,
                product: product.name || product.description?.slice(0, 50) || 'Product',
                price: product.price || 'TBD',
                quantity: 1,
                buyer: interaction.user.id,
                seller: product.seller,
                status: '⏳ Pending',
                createdAt: new Date().toISOString()
            };
            saveData('orders.json', orders);
            
            const ticketChannel = await guild.channels.create({
                name: `order-${orderNo}`,
                type: ChannelType.GuildText,
                parent: guild.channels.cache.find(c => c.name.includes('SUPPORT'))?.id,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionBits.Flags.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionBits.Flags.ViewChannel, PermissionBits.Flags.SendMessages, PermissionBits.Flags.ReadMessageHistory] },
                    { id: product.seller, allow: [PermissionBits.Flags.ViewChannel, PermissionBits.Flags.SendMessages, PermissionBits.Flags.ReadMessageHistory] }
                ]
            });
            
            const embed = new EmbedBuilder()
                .setTitle('🧾 Order #' + orderNo)
                .setDescription('**Product:** ' + (product.name || product.description?.slice(0, 50)) + '/n**Price:** ' + (product.price || 'TBD') + '/n**Quantity:** 1/n**Buyer:** <@' + interaction.user.id + '>/n/nComplete payment with the seller to confirm your order.')
                .setColor('#FF8800')
                .setFooter({ text: STORE_NAME })
                .setTimestamp();
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`send_upi_${orderId}`).setLabel('💳 Send Payment QR').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`complete_${orderId}`).setLabel('✅ Confirm & Complete').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 Close').setStyle(ButtonStyle.Danger)
            );
            
            await ticketChannel.send({ content: `<@${interaction.user.id}> <@${product.seller}>` , embeds: [embed], components: [row] });
            await interaction.reply({ content: `Order #${orderNo} created! Staff will review shortly. Channel: ${ticketChannel}`, ephemeral: true });
        }
        
        // Complete order - Staff only
        if (interaction.customId.startsWith('complete_')) {
            if (!interaction.member.roles.cache.some(r => ['Owner', 'Admin', 'Staff', 'Seller'].includes(r.name))) {
                return interaction.reply({ content: '❝ Staff only!', ephemeral: true });
            }
            
            await interaction.deferReply();
            
            const orderId = interaction.customId.replace('complete_', '');
            const orders = loadData('orders.json');
            const order = orders[orderId];
            if (!order) return interaction.editReply({ content: '❝ Not found!' });
            
            order.status = '✅ Completed';
            order.confirmedBy = interaction.user.id;
            order.confirmedAt = new Date().toISOString();
            saveData('orders.json', orders);
            
            const ordersChannel = interaction.guild.channels.cache.find(c => c.name === 'orders');
            if (ordersChannel) {
                const embed = new EmbedBuilder()
                    .setTitle('✅ Order Confirmed')
                    .setDescription('**Order No:** ' + order.orderNo + '/n**Product:** ' + order.product + '/n**Quantity:** ' + (order.quantity || 1) + '/n**Buyer:** <@' + order.buyer + '>')
                    .setColor('#00C853')
                    .setFooter({ text: STORE_NAME })
                    .setTimestamp();
                await ordersChannel.send({ embeds: [embed] });
            }
            
            await interaction.editReply({ content: '✅ Order #' + order.orderNo + ' confirmed by staff!' });
            
            // Now show vouch button to buyer ONLY after staff confirmed
            const vouchRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`vouch:${orderId}:${order.buyer}`).setLabel('⭐ Vouch Now').setStyle(ButtonStyle.Secondary)
            );
            
            const vouchPrompt = new EmbedBuilder()
                .setTitle('🎉 Order Complete!')
                .setDescription(`<@${order.buyer}>, your order **#${order.orderNo}** (${order.product}) has been **confirmed by staff**!`)
                .setColor('#FFD700')
                .setFooter({ text: STORE_NAME });
            
            await interaction.channel.send({ embeds: [vouchPrompt], components: [vouchRow] });
        }
        
        // UPI payment button in order ticket -> staff sends QR to buyer
        if (interaction.customId.startsWith('send_upi_')) {
            if (!interaction.member.roles.cache.some(r => ['Owner', 'Admin', 'Staff'].includes(r.name))) {
                return interaction.reply({ content: '❝ Staff only!', ephemeral: true });
            }
            
            await interaction.deferReply();
            
            const orderId = interaction.customId.replace('send_upi_', '');
            const orders = loadData('orders.json');
            const order = orders[orderId];
            if (!order) return interaction.editReply({ content: '❝ Not found!' });
            
            const amount = order.price ? String(order.price).replace(/[^0-9.]/g, '') : '';
            const note = 'Order #' + order.orderNo + ' - ' + order.product;
            
            const { embed, file } = await upiEmbed(config.upiId, amount, null, note);
            const payload = file ? { embeds: [embed], files: [file] } : { embeds: [embed] };
            await interaction.editReply({ content: `<@${order.buyer}>, here is the payment QR:`, ...payload });
            return;
        }
        
        // Giveaway enter button
        if (interaction.customId === 'enter_giveaway') {
            const giveaways = loadData('giveaways.json');
            const gId = interaction.message.id;
            const ga = giveaways[gId];
            if (!ga) return interaction.reply({ content: '❝ This giveaway has ended.', ephemeral: true });
            if (Date.now() > ga.endTime) return interaction.reply({ content: '❝ This giveaway has ended.', ephemeral: true });
            if (ga.entrants.includes(interaction.user.id)) {
                return interaction.reply({ content: '❝ You already entered!', ephemeral: true });
            }
            ga.entrants.push(interaction.user.id);
            // Deduplicate
            ga.entrants = [...new Set(ga.entrants)];
            saveData('giveaways.json', giveaways);
            // Don't append entries text, replace it
            try {
                const embed = interaction.message.embeds[0];
                if (embed) {
                    let desc = embed.description || '';
                    desc = desc.replace(/.*Entries:.*d+/g, '');
                    desc += '/n/n**Entries:** ' + ga.entrants.length;
                    const newEmbed = EmbedBuilder.from(embed).setDescription(desc);
                    await interaction.message.edit({ embeds: [newEmbed] });
                }
            } catch (e) { /* ignore */ }
            
            await interaction.reply({ content: `🎉 You entered the giveaway! (${ga.entrants.length} entries)`, ephemeral: true });
            return;
        }
        
        // Vouch button in order ticket -> opens vouch modal
        if (interaction.customId.startsWith('vouch:')) {
            const parts = interaction.customId.split(':'); // vouch:orderId:buyerId
            const orderId = parts[1]; // e.g. "order_5"
            const buyerId = parts[2]; // actual Discord user ID
            
            if (interaction.user.id !== buyerId) {
                return interaction.reply({ content: '❝ Only the buyer of this order can vouch!', ephemeral: true });
            }
            
            const orders = loadData('orders.json');
            const order = orders[orderId];
            if (!order) return interaction.reply({ content: '❝ Order not found!', ephemeral: true });
            
            if (!order.confirmedBy) {
                return interaction.reply({ content: '❝ Order must be confirmed by staff before you can vouch! Wait for staff to complete your order first!', ephemeral: true });
            }
            
            const modal = new ModalBuilder()
                .setCustomId(`vouch_modal:${orderId}`)
                .setTitle('⭐ Leave a Vouch');
            
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('vouch_rating')
                        .setLabel('Rating (1-5)')
                        .setStyle(TextInputStyle.Short)
                        .setValue('5')
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('vouch_review')
                        .setLabel('Your review')
                        .setStyle(TextInputStyle.Paragraph)
                        .setPlaceholder(`How was buying ${order.product}?`)
                        .setRequired(true)
                )
            );
            
            await interaction.showModal(modal);
        }
    }
    
    // Modal submit
    if (interaction.isModalSubmit()) {
        // Vouch modal
        if (interaction.customId.startsWith('vouch_modal:')) {
            const orderId = interaction.customId.replace('vouch_modal:', '');
            const orders = loadData('orders.json');
            const order = orders[orderId];
            if (!order) return interaction.reply({ content: '❝ Order not found!', ephemeral: true });
            
            const rating = interaction.fields.getTextInputValue('vouch_rating');
            const review = interaction.fields.getTextInputValue('vouch_review');
            
            const sellerId = order.seller;
            const sellerTag = interaction.guild.members.cache.get(sellerId)?.user?.tag || 'Seller';
            
            // Save vouch
            const vouches = loadData('vouches.json');
            if (!vouches[sellerId]) vouches[sellerId] = { count: 0, reviews: [] };
            vouches[sellerId].count++;
            vouches[sellerId].reviews.push({
                from: interaction.user.id,
                fromTag: interaction.user.tag,
                product: order.product,
                orderNo: order.orderNo,
                rating: rating,
                review: review,
                date: new Date().toISOString()
            });
            saveData('vouches.json', vouches);
            if (interaction.guild) await assignVerifiedBuyer(interaction.guild, interaction.user.id);
            
            order.status = '✅ Completed (Vouched)';
            order.vouched = true;
            order.vouchReview = review;
            order.vouchRating = rating;
            order.completedAt = new Date().toISOString();
            saveData('orders.json', orders);
            
            const stars = '⭐'.repeat(Math.min(parseInt(rating) || 5, 5));
            
            const vouchEmbed = new EmbedBuilder()
                .setTitle('✨⭐🎉 New Vouch!')
                .setDescription(`**${interaction.user.tag}** vouched for **${sellerTag}**`)
                .addFields(
                    { name: '🛒 Product', value: order.product, inline: true },
                    { name: '🧾 Order', value: '#' + order.orderNo, inline: true },
                    { name: 'Rating', value: `${stars} (${rating}/5)` },
                    { name: '📝 Review', value: review },
                    { name: 'Total Vouches', value: '' + vouches[sellerId].count }
                )
                .setColor('#FFD700')
                .setFooter({ text: STORE_NAME });
            
            const vouchChannel = guild.channels.cache.find(c => c.name === 'vouches');
            if (vouchChannel) await vouchChannel.send({ embeds: [vouchEmbed] });
            
            const ordersChannel = guild.channels.cache.find(c => c.name === 'orders');
            if (ordersChannel) {
                const completeEmbed = new EmbedBuilder()
                    .setTitle('✨⭐✅ Order Completed')
                    .setDescription('**Order:** #' + order.orderNo + '/n**Product:** ' + order.product + '/n**Buyer:** <@' + interaction.user.id + '>')
                    .addFields(
                        { name: '⭐ Vouch', value: `${stars} //cdot ${review}` },
                        { name: '🕒 Completed', value: `<t:${Math.floor(Date.now() / 1000)}:R>` }
                    )
                    .setColor('#00C853')
                    .setFooter({ text: STORE_NAME });
                
                const orderMsg = await ordersChannel.send({ embeds: [completeEmbed] });
                await orderMsg.react('/u2705').catch(() => {});
            }
            
            await interaction.reply({ content: '✅ Vouch submitted! Posted in #vouches and logged in #orders.', ephemeral: true });
            return;
        }
        
        // Announcement modal
        if (interaction.customId === 'announcement_modal') {
            const title = interaction.fields.getTextInputValue('ann_title');
            const body = interaction.fields.getTextInputValue('ann_body');
            const colorHex = interaction.fields.getTextInputValue('ann_color') || 'FF5555';
            const pingChoice = (interaction.fields.getTextInputValue('ann_ping') || 'none').toLowerCase();
            let pingText = '';
            if (pingChoice === 'everyone') pingText = '@everyone ';
            else if (pingChoice === 'here') pingText = '@here ';
            const embed = new EmbedBuilder()
                .setTitle('📢 ' + title)
                .setDescription(body)
                .setColor('#' + colorHex.replace('#', ''))
                .setFooter({ text: STORE_NAME + ' · Announcement' })
                .setTimestamp();
            const targetChannel = interaction.guild.channels.cache.find(c => c.name === (interaction.options?.getString('channel') || 'announce'));
            if (!targetChannel) return interaction.reply({ content: '❝ Could not find #announce channel!', ephemeral: true });
            await targetChannel.send({ content: pingText, embeds: [embed] });
            await interaction.reply({ content: '✅ Announcement sent to ' + targetChannel + '!', ephemeral: true });
            return;
        }
        
        // Product modal
        if (interaction.customId.startsWith('product_modal_')) {
            const channelName = interaction.customId.replace('product_modal_', '');
            const desc = interaction.fields.getTextInputValue('product_desc');
            const products = loadData('products.json');
            const id = Date.now().toString();
            products[id] = { description: desc, seller: interaction.user.id, channel: channelName, createdAt: new Date().toISOString() };
            saveData('products.json', products);
            
            const embed = new EmbedBuilder()
                .setDescription(desc)
                .setColor('#00C853')
                .setFooter({ text: STORE_NAME + ' · ' + channelName })
                .setTimestamp();
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`buy_${id}`).setLabel('Order Now').setStyle(ButtonStyle.Success).setEmoji('🛒')
            );
            
            const shopChannel = guild.channels.cache.find(c => c.name === channelName) || guild.channels.cache.find(c => c.name === 'restock');
            if (shopChannel) {
                await shopChannel.send({ embeds: [embed], components: [row] });
                await interaction.reply({ content: '✅ Posted in #' + shopChannel.name + '!', ephemeral: true });
            } else {
                await interaction.reply({ content: '❝ Channel not found.', ephemeral: true });
            }
            return;
        }
        
        // Order modal
        if (interaction.customId === 'order_modal') {
            const product = interaction.fields.getTextInputValue('order_product');
            const qty = interaction.fields.getTextInputValue('order_qty');
            const price = interaction.fields.getTextInputValue('order_price') || 'TBD';
            const notes = interaction.fields.getTextInputValue('order_notes') || 'None';
            const orderNo = getNextOrderNo();
            const orders = loadData('orders.json');
            const orderId = 'order_' + orderNo;
            orders[orderId] = {
                orderNo,
                product,
                quantity: qty,
                price,
                notes,
                buyer: interaction.user.id,
                status: '⏳ Pending',
                createdAt: new Date().toISOString()
            };
            saveData('orders.json', orders);
            
            const ticketChannel = await guild.channels.create({
                name: `order-${orderNo}`,
                type: ChannelType.GuildText,
                parent: guild.channels.cache.find(c => c.name.includes('SUPPORT'))?.id,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionBits.Flags.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionBits.Flags.ViewChannel, PermissionBits.Flags.SendMessages, PermissionBits.Flags.ReadMessageHistory] }
                ]
            });
            
            const embed = new EmbedBuilder()
                .setTitle('🧾 Order #' + orderNo)
                .setDescription('**Product:** ' + product + '/n**Quantity:** ' + qty + '/n**Offer:** ' + price + '/n**Notes:** ' + notes + '/n**Buyer:** <@' + interaction.user.id + '>/n/nA staff member will confirm your order shortly.')
                .setColor('#FF8800')
                .setFooter({ text: STORE_NAME })
                .setTimestamp();
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`send_upi_${orderId}`).setLabel('💳 Send Payment QR').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`complete_${orderId}`).setLabel('✅ Confirm & Complete').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 Close').setStyle(ButtonStyle.Danger)
            );
            
            // Only ping owner if ownerId is set
            const pingContent = config.ownerId ? `<@${interaction.user.id}>/<@${config.ownerId}>` : `<@${interaction.user.id}>`;
            
            await ticketChannel.send({ content: pingContent, embeds: [embed], components: [row] });
            await interaction.reply({ content: '✅ Order #' + orderNo + ' placed!', ephemeral: true });
        }
    }
});

// ==================== VOUCH MESSAGE DETECTION ====================
// When someone types a vouch like "+legit bought potato in 20 rupees"
// in #vouches, this automatically:
//   1. Parses the product & price
//   2. Assigns an order number
//   3. Posts an "Order Completed" box in #orders
//   4. Logs the vouch for the seller
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    const vouchChannel = message.guild?.channels.cache.find(c => c.name === 'vouches');
    if (!vouchChannel) return;
    if (message.channel.id !== vouchChannel.id) return;
    
    const text = message.content;
    const vouchKeywords = /(?:legit|rep|bought|vouch|purchased|trusted|positive)/i;
    if (!vouchKeywords.test(text)) return;
    
    // 1) Parse the seller - first mention, or snowflake ID in text, else store owner
    let sellerId = message.mentions.users.first()?.id;
    if (!sellerId) {
        const snowflake = text.match(/([0-9]{17,20})/);
        if (snowflake) sellerId = snowflake[1];
    }
    // Validate seller is a real guild member
    if (sellerId) {
        const sellerMember = message.guild.members.cache.get(sellerId);
        if (!sellerMember) sellerId = null;
    }
    if (!sellerId && config.ownerId) sellerId = config.ownerId;
    if (!sellerId) {
        // No seller found - ask user to mention the seller
        await message.reply('Please mention the seller! Example: `+legit bought nitro 1m rs600 @Seller`').catch(() => {});
        return;
    }
    
    // 2) Parse the product - text after "bought/purchased"
    let product = 'Unknown Product';
    const boughtMatch = text.match(/(?:bought|purchased)[ ]+(?:1x[ ]*|x[ ]*|[0-9]+[ ]*x[ ]*)?(.+?)(?:[ ]+(?:for|in|at)[ ]+[$]?[ ]*[0-9]|[ ]*$)/i);
    if (boughtMatch && boughtMatch[1].trim()) {
        let p = boughtMatch[1].trim();
        // strip trailing number IDs
        p = p.replace(/[ ]*[0-9]{17,20}/, '');
        // strip trailing "legit/trusted/vouch/positive..." words
        p = p.replace(/[ ]+(?:legit|trusted|vouch|positive).*$/i, '');
        p = p.trim();
        // split on spaces/brackets/pipes, filter noise words
        const stop = new Set(['fw', 'for', 'in', 'at', 'bought', 'the', 'a']);
        const words = p.split(/[ |[]/).filter(w => w.length > 0 && w.length < 20 && !/%/.test(w) && !stop.has(w.toLowerCase()));
        product = words.slice(0, 4).join(' ') || 'Unknown Product';
    }
    
    // 3) Parse the price
    let price = '';
    let m = text.match(/([0-9]+(?:[.][0-9]+)?)[ ]*(?:rs|rupees|inr|[$]|usd|dollars|euros|bucks)/i);
    if (!m) m = text.match(/[$][ ]*([0-9]+(?:[.][0-9]+)?)/);
    if (!m) m = text.match(/(?:for|in|at)[ ]+([0-9]+(?:[.][0-9]+)?)/i);
    if (m) {
        const amount = m[1];
        if (/[$]|usd|dollars/i.test(m[0])) price = '$' + amount;
        else if (/euro/i.test(m[0])) price = 'EUR ' + amount;
        else price = 'INR ' + amount;
    }
    
    // 4) Generate order number
    const orderNo = getNextOrderNo();
    
    // 5) Save the order as completed
    const orders = loadData('orders.json');
    const orderId = `auto_${orderNo}`;
    orders[orderId] = {
        orderNo,
        product,
        price: price || 'N/A',
        buyer: message.author.id,
        seller: sellerId,
        status: '✅ Completed',
        source: 'vouch-message',
        vouched: true,
        vouchText: text,
        completedAt: new Date().toISOString()
    };
    saveData('orders.json', orders);
    
    // 6) Save the vouch for the seller
    const vouches = loadData('vouches.json');
    if (!vouches[sellerId]) vouches[sellerId] = { count: 0, reviews: [] };
    vouches[sellerId].count++;
    vouches[sellerId].reviews.push({
        from: message.author.id,
        fromTag: message.author.tag,
        product,
        orderNo,
        review: text,
        date: new Date().toISOString()
    });
    saveData('vouches.json', vouches);
    if (message.guild) await assignVerifiedBuyer(message.guild, message.author.id);
    
    // 7) POST the "Order Completed" box in #orders (aesthetic design)
    const ordersChannel = message.guild.channels.cache.find(c => c.name === 'orders');
    if (ordersChannel) {
        const sellerTag = message.guild.members.cache.get(sellerId)?.user?.tag || (sellerId === config.ownerId ? STORE_NAME : 'Seller');
        const vouchText = text.length > 150 ? text.slice(0, 147) + '...' : text;
        const completeEmbed = new EmbedBuilder()
            .setTitle('✨ ORDER #' + orderNo)
            .setDescription(`**Item:** ${product}/n**Price:** ${price || 'N/A'}/n**Buyer:** <@${message.author.id}>/n**Seller:** ${sellerTag}`)
            .addFields(
                { name: '⭐ Vouch', value: '> ' + vouchText },
                { name: '🕒 Completed', value: `<t:${Math.floor(Date.now() / 1000)}:R>` }
            )
            .setColor('#00C853')
            .setFooter({ text: STORE_NAME + ' · Confirmed Order' })
            .setTimestamp();
        const orderMsg = await ordersChannel.send({ embeds: [completeEmbed] });
        await orderMsg.react('/u2705').catch(() => {});
    }
    
    // 8) Confirm to the buyer + add a vouch reaction embed
    const vouchEmbed = new EmbedBuilder()
        .setTitle('✨⭐🎉 Vouch Logged')
        .setDescription(`Vouch submitted for **${product}** - **${price || 'N/A'}**`)
        .addFields(
            { name: '🧾 Order No', value: '#' + orderNo, inline: true },
            { name: '👤 Buyer', value: '<@${message.author.id}>', inline: true }
        )
        .setColor('#FFD700')
        .setFooter({ text: STORE_NAME + ' · Vouch #${vouches[sellerId].count}' });
    
    await message.channel.send({ embeds: [vouchEmbed] });
});

// ==================== DM COMMANDS (FALLBACK) ====================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.guild) return; // only handle DMs here
    
    const text = message.content.trim().toLowerCase();
    
    // Respond to: upi, /upi, pay, payment, scanner
    if (/^(upi|[/]upi|pay|payment|scanner|qr)[ !.]?.*$/i.test(text)) {
        const { embed, file } = await upiEmbed(config.upiId, null, null, null);
        const payload = file ? { embeds: [embed], files: [file] } : { embeds: [embed] };
        await message.channel.send(payload);
        return;
    }
    
    // If DM was a vouch-style message from a buyer, log it like in #vouches
    const vouchKeywords = /(?:legit|rep|bought|vouch|purchased|trusted|positive)/i;
    if (vouchKeywords.test(text)) {
        // Load vouches for the store owner as seller
        const sellerId = config.ownerId;
        const vouches = loadData('vouches.json');
        if (!vouches[sellerId]) vouches[sellerId] = { count: 0, reviews: [] };
        vouches[sellerId].count++;
        vouches[sellerId].reviews.push({
            from: message.author.id,
            fromTag: message.author.tag,
            product: 'DM vouch',
            review: message.content,
            date: new Date().toISOString()
        });
        saveData('vouches.json', vouches);
        await message.channel.send('⭐ Vouch recorded! Thanks for trusting ' + STORE_NAME + '!');
    }
});

// ==================== LEVELING + ANTI-SCAM ====================
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    
    // ANTI-SCAM: check every message
    if (await antiScamCheck(message)) {
        try {
            await message.delete();
            const warn = await message.channel.send(`⚠️ <@${message.author.id}> that message looked like a scam link and was deleted. If this is a mistake, message staff!`);
            setTimeout(() => warn.delete().catch(() => {}), 8000);
            // Log to ticket-logs
            const logChannel = message.guild.channels.cache.find(c => c.name === 'ticket-logs');
            if (logChannel) {
                const logEmbed = new EmbedBuilder()
                    .setTitle('🛡️ Scam Attempt Blocked')
                    .setDescription(`**User:** <@${message.author.id}>/n**Channel:** <#${message.channel.id}>/n**Message:** ` + '`' + message.content.slice(0, 300) + '`')
                    .setColor('#FF0000')
                    .setTimestamp();
                await logChannel.send({ embeds: [logEmbed] });
            }
        } catch (e) { /* ignore */ }
        return;
    }
    
    // LEVELING: earn XP in chat channels (skip tickets/commands)
    const channelName = message.channel.name || '';
    if (/^order-|^support-|^ticket-/.test(channelName)) return;
    if (message.content.startsWith('/')) return;
    await grantXp(message.member);
});

// ==================== WELCOME ====================
client.on('guildMemberAdd', async (member) => {
    const welcomeChannel = member.guild.channels.cache.find(c => c.name === 'welcome-back');
    if (!welcomeChannel) return;
    
    const embed = new EmbedBuilder()
        .setTitle(`👋 Welcome, ${member.user.username}!`)
        .setDescription(`Welcome to ${STORE_NAME}!/
                **🛒** Check our shops for the latest stock/
                **✅** Trusted vouches in #vouches/
                **💬** Chat with us in #general-chat/
                **🎫** Buy via order tickets!/
                /nRead #rules first!`)
        .setThumbnail(member.user.displayAvatarURL())
        .setColor('#00C853')
        .setFooter({ text: STORE_NAME })
        .setTimestamp();
    
    await welcomeChannel.send({ content: `Welcome <@${member.user.id}>! 🎉`, embeds: [embed] });
    
    // Auto-assign Member role
    const memberRole = member.guild.roles.cache.find(r => r.name === 'Member');
    if (memberRole) await member.roles.add(memberRole).catch(() => {});
});

// ==================== LOGIN ====================
if (process.env.TOKEN || process.env.DISCORD_TOKEN) config.token = process.env.TOKEN || process.env.DISCORD_TOKEN;
if (!config.token || config.token === 'YOUR_BOT_TOKEN_HERE') {
    console.error('Please set your bot token in config.json (or TOKEN env var)!');
    process.exit(1);
}

// Health server MUST start first to keep Render alive
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
}).listen(PORT, () => {
    console.log('Health check server on port ' + PORT);
});

// Global error handler - prevent crashes
process.on('unhandledRejection', (err) => {
    console.error('Unhandled:', err.message || err);
});

client.login(config.token);