const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Load config.json if present, otherwise rely on environment variables.
// Never commit config.json to GitHub - use TOKEN / GUILD_ID / OWNER_ID env vars.
let config = {};
try {
    config = require('./config.json');
} catch (e) {
    console.log('config.json not found - using environment variables.');
}
config.token = process.env.TOKEN || process.env.DISCORD_TOKEN || config.token;
config.guildId = process.env.GUILD_ID || config.guildId || '';
config.ownerId = process.env.OWNER_ID || config.ownerId || '';

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

// Data storage
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

function loadData(file) {
    const filePath = path.join(dataDir, file);
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveData(file, data) {
    fs.writeFileSync(path.join(dataDir, file), JSON.stringify(data, null, 2));
}

// Animated neon reaction cascade - emojis pop in one by one,
// creating a glowing "neon" celebration effect on a message.
async function neonReact(message, emojis = ['⭐', '✨', '✅', '🎉']) {
    try {
        for (const e of emojis) {
            await message.react(e);
            await new Promise(r => setTimeout(r, 400));
        }
    } catch (e) {
        // ignore - reactions are cosmetic
    }
}

// Neon "rainbow" reaction ring for special moments
async function neonBurst(message) {
    try {
        const ring = ['⭐', '✨', '🔥', '✅', '🎉', '💎'];
        for (let i = 0; i < ring.length; i++) {
            await message.react(ring[i]);
            await new Promise(r => setTimeout(r, 300));
        }
    } catch (e) { /* ignore */ }
}

// Replace (or create) an embed with the given title in a channel.
// - Deletes OLD bot-posted embeds with the same title (so new changes appear)
// - NEVER deletes user messages (reps, orders, chats stay safe)
// - Only sends if the embed content actually changed
async function replaceEmbed(channel, title, newEmbed, row) {
    try {
        const messages = await channel.messages.fetch({ limit: 50 });
        const oldMessages = messages.filter(m => m.author.bot && m.embeds.some(e => e.title === title));
        if (oldMessages.size > 0) {
            const newest = oldMessages.first();
            const oldDesc = newest.embeds[0]?.description || '';
            const newDesc = newEmbed.data.description || '';
            if (oldDesc === newDesc && oldMessages.size <= 1) {
                return; // content identical - nothing new to change
            }
            await channel.bulkDelete(oldMessages).catch(() => {});
            console.log(`Refreshed embed in #${channel.name}: ${title}`);
        }
        await channel.send({ embeds: [newEmbed], components: row ? [row] : undefined });
    } catch (e) {
        // fallback: just send if we can't read history
        await channel.send({ embeds: [newEmbed], components: row ? [row] : undefined }).catch(() => {});
    }
}

let orderCounter = loadData('counter.json').orderCounter || 0;

// ==================== SERVER SETUP (Xero's Store layout) ====================
async function setupServer(guild) {
    console.log(`Setting up server: ${guild.name}`);
    const guildId = guild.id;

    // Track whether this server was already set up before.
    // If yes, we NEVER re-create channels (so channels the owner
    // deleted stay deleted). We only refresh permissions & messages.
    const setupState = loadData('setup-state.json');
    const isFirstSetup = !setupState[guildId];
    console.log(isFirstSetup ? 'First-time setup - creating channels...' : 'Re-setup - keeping existing channels, not re-creating deleted ones.');

    // Create roles
    const roles = [
        { name: 'Owner', color: '#FF0000', permissions: [PermissionFlagsBits.Administrator] },
        { name: 'Admin', color: '#FF5555', permissions: [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ManageMessages] },
        { name: 'Staff', color: '#FF8800', permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers] },
        { name: 'Seller', color: '#00C853', permissions: [] },
        { name: 'Buyer', color: '#0099FF', permissions: [] },
        { name: 'Verified', color: '#00E5FF', permissions: [] },
        { name: 'Trusted', color: '#FFD700', permissions: [] },
        { name: 'Member', color: '#808080', permissions: [] }
    ];

    const createdRoles = {};
    for (const roleData of roles) {
        const existing = guild.roles.cache.find(r => r.name === roleData.name);
        if (existing) {
            createdRoles[roleData.name] = existing;
        } else {
            const role = await guild.roles.create({
                name: roleData.name,
                color: roleData.color,
                permissions: roleData.permissions,
                reason: 'Xero Store setup'
            });
            createdRoles[roleData.name] = role;
        }
    }

    // Channel structure (from screenshot)
    const structure = [
        { category: `🛡️ ${STORE_NAME} » INFO`, channels: [
            { name: 'announce', type: ChannelType.GuildText, topic: 'Important announcements' },
            { name: 'rules', type: ChannelType.GuildText, topic: 'Read before buying!' },
            { name: 'events', type: ChannelType.GuildText, topic: 'Events & giveaways' },
            { name: 'giveaway', type: ChannelType.GuildText, topic: 'Giveaways' }
        ]},
        { category: `🛒 ${STORE_NAME} » SHOPS`, channels: [
            { name: 'restock', type: ChannelType.GuildText, topic: 'New stock drops' },
            { name: 'restock-2', type: ChannelType.GuildText, topic: 'More stock' },
            { name: 'game-acc', type: ChannelType.GuildText, topic: 'Game accounts' },
            { name: 'pc-parts', type: ChannelType.GuildText, topic: 'PC parts & hardware' }
        ]},
        { category: `✅ ${STORE_NAME} » LEGITNESS`, channels: [
            { name: 'proofs', type: ChannelType.GuildText, topic: 'Proof of past sales' },
            { name: 'vouches', type: ChannelType.GuildText, topic: 'Customer vouches' },
            { name: 'orders', type: ChannelType.GuildText, topic: 'Order confirmation log' }
        ]},
        { category: `💬 ${STORE_NAME} » MEMBERS`, channels: [
            { name: 'general-chat', type: ChannelType.GuildText, topic: 'General discussion - feel free to chat here!' },
            { name: 'welcome-back', type: ChannelType.GuildText, topic: 'Say hi to the community!' },
            { name: 'introduce', type: ChannelType.GuildText, topic: 'Introduce yourself' },
            { name: 'level-up', type: ChannelType.GuildText, topic: 'Level up discussion' },
            { name: 'feedback', type: ChannelType.GuildText, topic: 'Give us feedback' },
            { name: 'mirrors', type: ChannelType.GuildText, topic: 'Mirror links' },
            { name: 'backups', type: ChannelType.GuildText, topic: 'Backup server links' }
        ]},
        { category: `🎫 ${STORE_NAME} » SUPPORT`, channels: [
            { name: 'create-ticket', type: ChannelType.GuildText, topic: 'Click the button to buy or get help' },
            { name: 'ticket-logs', type: ChannelType.GuildText, topic: 'Ticket transcripts' }
        ]},
        { category: `🔊 ${STORE_NAME} » VOICE`, channels: [
            { name: 'General Voice', type: ChannelType.GuildVoice },
            { name: 'Buyers Chat', type: ChannelType.GuildVoice }
        ]}
    ];

    // ONLY create channels on first-time setup.
    // On re-setup, deleted channels stay deleted (we respect the owner).
    if (isFirstSetup) {
        for (const catData of structure) {
            let category = guild.channels.cache.find(c => c.name === catData.category && c.type === ChannelType.GuildCategory);
            if (!category) {
                category = await guild.channels.create({
                    name: catData.category,
                    type: ChannelType.GuildCategory
                });
            }
            for (const chData of catData.channels) {
                const existing = guild.channels.cache.find(c => c.name === chData.name);
                if (!existing) {
                    await guild.channels.create({
                        name: chData.name,
                        type: chData.type,
                        parent: category.id,
                        topic: chData.topic || ''
                    });
                }
            }
        }
    }

    // ===== READ-ONLY PERMISSIONS =====
    // All channels are read-only for everyone EXCEPT:
    //   - general-chat (open for chatting)
    //   - vouches (needed for the auto-vouch system)
    //   - voice channels (need to be able to talk)
    // Staff/Admin roles keep full access everywhere.
    const openChannels = new Set(['general-chat', 'vouches']);
    const staffRole = guild.roles.cache.find(r => r.name === 'Admin') || guild.roles.cache.find(r => r.name === 'Owner');
    const sellerRole = guild.roles.cache.find(r => r.name === 'Seller');

    for (const ch of guild.channels.cache.values()) {
        if (ch.type === ChannelType.GuildCategory) continue;
        if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) continue;
        if (ch.type === ChannelType.GuildVoice) continue;

        // Skip channels that should stay open
        if (openChannels.has(ch.name)) continue;
        // Skip ticket channels (they have their own per-user permissions)
        if (/^order-|^support-|^ticket-/.test(ch.name)) continue;

        // Lock @everyone down to read-only
        await ch.permissionOverwrites.edit(guild.id, {
            SendMessages: false,
            AddReactions: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
            SendMessagesInThreads: false,
            SendVoiceMessages: false,
            UseApplicationCommands: true,
            Connect: true
        }, { reason: 'Read-only channel' });

        // Give staff full send permissions
        if (staffRole) {
            await ch.permissionOverwrites.edit(staffRole.id, {
                SendMessages: true,
                AddReactions: true,
                ManageMessages: true,
                ManageChannels: true
            }, { reason: 'Staff access' });
        }
        if (sellerRole && ['restock', 'restock-2', 'game-acc', 'pc-parts'].includes(ch.name)) {
            await ch.permissionOverwrites.edit(sellerRole.id, {
                SendMessages: true,
                AddReactions: true
            }, { reason: 'Seller access in shop channels' });
        }
    }
    console.log('Read-only permissions applied (except general-chat & vouches).');

    // Rules embed - clean point-wise with spacing
    const rulesChannel = guild.channels.cache.find(c => c.name === 'rules');
    if (rulesChannel) {
        const rulesEmbed = new EmbedBuilder()
            .setTitle(`📋 ${STORE_NAME} - Server Rules`)
            .setDescription(`> Welcome! Please read before buying. Keep it simple.\n\n` +
                `**1️⃣  Be Respectful**\n> No harassment, hate speech, or toxicity. Treat others how you want to be treated.\n\n` +
                `**2️⃣  No Scamming**\n> Scamming = **instant ban**. No warnings. We take this seriously.\n\n` +
                `**3️⃣  Vouch After Purchase**\n> Got your product? Leave a vouch in #vouches to build trust.\n\n` +
                `**4️⃣  Orders Only via Tickets**\n> All purchases go through **Place Order** in #create-ticket. No DMs.\n\n` +
                `**5️⃣  Chat in General**\n> Most channels are **read-only**. Chat freely in #general-chat.\n\n` +
                `**6️⃣  Proof for Sellers**\n> Sellers must show **proofs** in #proofs before listing products.\n\n` +
                `**7️⃣  Follow Discord ToS**\n> Discord rules always apply. No loopholes.`)
            .setColor('#FF5555')
            .setFooter({ text: STORE_NAME })
            .setTimestamp();
        await replaceEmbed(rulesChannel, `📋 ${STORE_NAME} - Server Rules`, rulesEmbed);

        // "How to Buy" embed - clean 5 steps with spacing
        const ticketRef = `<#${guild.channels.cache.find(c => c.name === 'create-ticket')?.id || 'create-ticket'}>`;
        const howToBuyEmbed = new EmbedBuilder()
            .setTitle(`🛒 How to Buy - ${STORE_NAME}`)
            .setDescription(`Getting your product is easy, just 5 steps:\n\n` +
                `**Step 1️⃣**  Go to ${ticketRef}\n` +
                `**Step 2️⃣**  Click the **"Place Order"** button\n` +
                `**Step 3️⃣**  Fill in product name & quantity\n` +
                `**Step 4️⃣**  Wait for staff confirmation\n` +
                `**Step 5️⃣**  Receive product, then vouch in #vouches`)
            .setColor('#00C853')
            .setFooter({ text: STORE_NAME });
        await replaceEmbed(rulesChannel, `🛒 How to Buy - ${STORE_NAME}`, howToBuyEmbed);
    }

    // Welcome channel
    const welcomeChannel = guild.channels.cache.find(c => c.name === 'welcome-back');
    if (welcomeChannel) {
        const welcomeEmbed = new EmbedBuilder()
            .setTitle(`👋 Welcome to ${STORE_NAME}!`)
            .setDescription(`Your trusted marketplace for Nitro, boosters, game accounts, and more!\n\n` +
                `**🛒 Check our shops:**\n` +
                `• <#${guild.channels.cache.find(c => c.name === 'restock')?.id || 'restock'}> - Latest stock\n` +
                `• <#${guild.channels.cache.find(c => c.name === 'game-acc')?.id || 'game-acc'}> - Game accounts\n\n` +
                `**✅ Why trust us?**\n` +
                `• ⭐ Real customer vouches in <#${guild.channels.cache.find(c => c.name === 'vouches')?.id || 'vouches'}>\n` +
                `• 🧾 Every order logged in <#${guild.channels.cache.find(c => c.name === 'orders')?.id || 'orders'}>\n` +
                `• 📜 Proofs in the LEGITNESS category\n\n` +
                `**💬 Chat with us in <#${guild.channels.cache.find(c => c.name === 'general-chat')?.id || 'general-chat'}>**\n` +
                `**🎫 Need help?** Create a ticket!`)
            .setImage('https://media.tenor.com/EWwYmIsWKroAAAAM/kaneki-tokyo-ghoul.gif')
            .setColor('#00C853')
            .setFooter({ text: STORE_NAME })
            .setTimestamp();
        await replaceEmbed(welcomeChannel, `👋 Welcome to ${STORE_NAME}!`, welcomeEmbed);
    }

    // Create order button in create-ticket
    const ticketChannel = guild.channels.cache.find(c => c.name === 'create-ticket');
    if (ticketChannel) {
        const ticketEmbed = new EmbedBuilder()
            .setTitle(`🎫 ${STORE_NAME} - Orders & Support`)
            .setDescription(`Click a button below:\n\n` +
                `🛒 **Place Order** - Buy a product\n` +
                `🎧 **Support** - Get help with a problem`)
            .setColor('#0099FF')
            .setFooter({ text: STORE_NAME });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('place_order').setLabel('Place Order').setStyle(ButtonStyle.Success).setEmoji('🛒'),
                new ButtonBuilder().setCustomId('support_ticket').setLabel('Support').setStyle(ButtonStyle.Primary).setEmoji('🎧')
            );

        await replaceEmbed(ticketChannel, `🎫 ${STORE_NAME} - Orders & Support`, ticketEmbed, row);
    }

    // Orders channel
    const ordersChannel = guild.channels.cache.find(c => c.name === 'orders');
    if (ordersChannel) {
        const ordersEmbed = new EmbedBuilder()
            .setTitle(`🧾 ${STORE_NAME} Order Log`)
            .setDescription('Confirmed orders will appear here.')
            .setColor('#FF8800')
            .setFooter({ text: STORE_NAME });
        await replaceEmbed(ordersChannel, `🧾 ${STORE_NAME} Order Log`, ordersEmbed);
    }

    // Vouches channel
    const vouchesChannel = guild.channels.cache.find(c => c.name === 'vouches');
    if (vouchesChannel) {
        const vouchesEmbed = new EmbedBuilder()
            .setTitle(`⭐ ${STORE_NAME} Vouches`)
            .setDescription('Customer vouches after successful purchases.')
            .setColor('#FFD700')
            .setFooter({ text: STORE_NAME });
        await replaceEmbed(vouchesChannel, `⭐ ${STORE_NAME} Vouches`, vouchesEmbed);
    }

    // Record that this guild has been set up (so re-runs don't recreate deleted channels)
    setupState[guildId] = Date.now();
    saveData('setup-state.json', setupState);

    console.log('Server setup complete!');
    return createdRoles;
}

// ==================== SLASH COMMANDS ====================
const commands = [
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Setup the full server structure (Admin only)'),
    new SlashCommandBuilder()
        .setName('vouch')
        .setDescription('Vouch for a user after successful purchase')
        .addUserOption(o => o.setName('user').setDescription('User to vouch for').setRequired(true))
        .addStringOption(o => o.setName('review').setDescription('Your review').setRequired(true))
        .addStringOption(o => o.setName('product').setDescription('What did they buy?').setRequired(false)),
    new SlashCommandBuilder()
        .setName('vouches')
        .setDescription('Check a user vouches')
        .addUserOption(o => o.setName('user').setDescription('User to check').setRequired(false)),
    new SlashCommandBuilder()
        .setName('product')
        .setDescription('Add a product to the shop (Seller/Admin)')
        .addStringOption(o => o.setName('name').setDescription('Product name').setRequired(true))
        .addStringOption(o => o.setName('price').setDescription('Price e.g. $5').setRequired(true))
        .addStringOption(o => o.setName('description').setDescription('Product description').setRequired(true))
        .addStringOption(o => o.setName('channel').setDescription('Shop channel: restock, game-acc, pc-parts').setRequired(false)),
    new SlashCommandBuilder()
        .setName('stock')
        .setDescription('List all products in the shop'),
    new SlashCommandBuilder()
        .setName('orders')
        .setDescription('Check your order status (Buyer)'),
    new SlashCommandBuilder()
        .setName('confirm')
        .setDescription('Confirm an order and mark as complete (Staff)')
        .addIntegerOption(o => o.setName('orderno').setDescription('Order number').setRequired(true)),
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show all commands'),
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Show store stats')
];

async function registerCommands(guild) {
    const rest = new REST({ version: '10' }).setToken(config.token);
    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
        console.log('Slash commands registered!');
    } catch (e) {
        console.error('Failed to register commands:', e.message);
    }
}

// ==================== EVENT HANDLERS ====================

client.on('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`📊 Servers: ${client.guilds.cache.size}`);

    // Register commands on all guilds
    for (const guild of client.guilds.cache.values()) {
        await registerCommands(guild);
    }

    client.user.setActivity(`${STORE_NAME} | /help`, { type: 'Watching' });
});

// Slash command handler
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;
    const { commandName } = interaction;

    try {
        switch (commandName) {
            case 'setup': {
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    return interaction.reply({ content: '❌ You need Administrator permission!', ephemeral: true });
                }
                await interaction.reply({ content: '⏳ Setting up server...', ephemeral: true });
                await setupServer(interaction.guild);
                await registerCommands(interaction.guild);
                await interaction.followUp({ content: '✅ Server setup complete!', ephemeral: true });
                break;
            }

            case 'vouch': {
                const target = interaction.options.getUser('user');
                const review = interaction.options.getString('review');
                const product = interaction.options.getString('product') || 'Unknown product';

                const vouches = loadData('vouches.json');
                if (!vouches[target.id]) vouches[target.id] = { count: 0, reviews: [] };
                vouches[target.id].count++;
                vouches[target.id].reviews.push({
                    from: interaction.user.id,
                    fromTag: interaction.user.tag,
                    product,
                    review,
                    date: new Date().toISOString()
                });
                saveData('vouches.json', vouches);

                const embed = new EmbedBuilder()
                    .setTitle('⭐ New Vouch!')
                    .setDescription(`**${interaction.user.tag}** vouched for **${target.tag}**`)
                    .addFields(
                        { name: '🛒 Product', value: product },
                        { name: '📝 Review', value: review },
                        { name: 'Total Vouches', value: `${vouches[target.id].count}` }
                    )
                    .setColor('#FFD700')
                    .setFooter({ text: STORE_NAME })
                    .setTimestamp();

                const vouchChannel = interaction.guild.channels.cache.find(c => c.name === 'vouches');
                if (vouchChannel) {
                    const vouchMsg = await vouchChannel.send({ embeds: [embed] });
                    await neonReact(vouchMsg, ['⭐', '✨', '✅', '🎉']).catch(() => {});
                }

                // AUTOMATICALLY post "Order Completed" in #orders when vouched
                const ordersChannel = interaction.guild.channels.cache.find(c => c.name === 'orders');
                if (ordersChannel) {
                    const completeEmbed = new EmbedBuilder()
                        .setTitle('✅ Order Completed')
                        .setDescription(`**Buyer:** ${interaction.user.tag}\n**Seller:** ${target.tag}\n**Product:** ${product}`)
                        .addFields(
                            { name: '⭐ Vouch', value: review },
                            { name: '🕒 Completed', value: `<t:${Math.floor(Date.now() / 1000)}:R>` }
                        )
                        .setColor('#00C853')
                        .setFooter({ text: `${STORE_NAME} · Order #${vouches[target.id].count}` })
                        .setTimestamp();
                    const orderMsg = await ordersChannel.send({ embeds: [completeEmbed] });
                    await neonBurst(orderMsg).catch(() => {});
                }

                await interaction.reply({ content: `✅ Vouched for ${target.tag}! Your vouch was logged in #vouches and #orders.`, ephemeral: true });
                break;
            }

            case 'vouches': {
                const target = interaction.options.getUser('user') || interaction.user;
                const vouches = loadData('vouches.json');
                const uv = vouches[target.id] || { count: 0, reviews: [] };

                const embed = new EmbedBuilder()
                    .setTitle(`⭐ Vouches for ${target.tag}`)
                    .setDescription(`**Total: ${uv.count}**`)
                    .setColor('#FFD700')
                    .setFooter({ text: STORE_NAME });

                if (uv.reviews.length > 0) {
                    uv.reviews.slice(-5).reverse().forEach(r => {
                        embed.addFields({ name: `By ${r.fromTag} (${r.product})`, value: `_${r.review}_ · ${new Date(r.date).toLocaleDateString()}` });
                    });
                }
                await interaction.reply({ embeds: [embed], ephemeral: true });
                break;
            }

            case 'product': {
                if (!interaction.member.roles.cache.find(r => ['Seller', 'Admin', 'Owner', 'Staff'].includes(r.name))) {
                    return interaction.reply({ content: '❌ You need the Seller role to add products!', ephemeral: true });
                }
                const name = interaction.options.getString('name');
                const price = interaction.options.getString('price');
                const desc = interaction.options.getString('description');
                const channelName = interaction.options.getString('channel') || 'restock';

                const products = loadData('products.json');
                const id = Date.now().toString();
                products[id] = {
                    name, price, description: desc,
                    seller: interaction.user.id,
                    channel: channelName,
                    createdAt: new Date().toISOString()
                };
                saveData('products.json', products);

                const embed = new EmbedBuilder()
                    .setTitle(`🛒 ${name}`)
                    .setDescription(desc)
                    .addFields(
                        { name: '💲 Price', value: price, inline: true },
                        { name: '👤 Seller', value: `<@${interaction.user.id}>`, inline: true }
                    )
                    .setColor('#00C853')
                    .setFooter({ text: `${STORE_NAME} · Stock drop` })
                    .setTimestamp();

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`buy_${id}`).setLabel('Order Now').setStyle(ButtonStyle.Success).setEmoji('🛒')
                );

                const shopChannel = interaction.guild.channels.cache.find(c => c.name === channelName) ||
                    interaction.guild.channels.cache.find(c => c.name === 'restock');
                if (shopChannel) {
                    await shopChannel.send({ embeds: [embed], components: [row] });
                    await interaction.reply({ content: `✅ Product posted in #${shopChannel.name}!`, ephemeral: true });
                } else {
                    await interaction.reply({ content: '❌ Could not find shop channel.', ephemeral: true });
                }
                break;
            }

            case 'stock': {
                const products = loadData('products.json');
                const list = Object.entries(products);
                if (list.length === 0) return interaction.reply({ content: 'No products listed yet.', ephemeral: true });

                const embed = new EmbedBuilder()
                    .setTitle(`🛒 ${STORE_NAME} Stock`)
                    .setColor('#00C853')
                    .setFooter({ text: STORE_NAME });

                list.forEach(([id, p]) => {
                    embed.addFields({ name: `${p.name} - ${p.price}`, value: `${p.description}\nSeller: <@${p.seller}>`, inline: false });
                });
                await interaction.reply({ embeds: [embed], ephemeral: true });
                break;
            }

            case 'orders': {
                const orders = loadData('orders.json');
                const userOrders = Object.values(orders).filter(o => o.buyer === interaction.user.id);
                if (userOrders.length === 0) return interaction.reply({ content: 'You have no orders yet.', ephemeral: true });

                const embed = new EmbedBuilder()
                    .setTitle(`🧾 Your Orders`)
                    .setColor('#FF8800')
                    .setFooter({ text: STORE_NAME });

                userOrders.slice(-5).reverse().forEach(o => {
                    embed.addFields({
                        name: `Order #${o.orderNo} - ${o.status}`,
                        value: `${o.product} x${o.quantity}\nPrice: ${o.price || 'TBD'}`
                    });
                });
                await interaction.reply({ embeds: [embed], ephemeral: true });
                break;
            }

            case 'confirm': {
                if (!interaction.member.roles.cache.find(r => ['Owner', 'Admin', 'Staff', 'Seller'].includes(r.name))) {
                    return interaction.reply({ content: '❌ Staff only!', ephemeral: true });
                }
                const orderNo = interaction.options.getInteger('orderno');
                const orders = loadData('orders.json');
                const order = Object.values(orders).find(o => o.orderNo === orderNo);
                if (!order) return interaction.reply({ content: '❌ Order not found!', ephemeral: true });

                order.status = '✅ Completed';
                order.confirmedBy = interaction.user.id;
                order.confirmedAt = new Date().toISOString();
                saveData('orders.json', orders);

                // Post to orders channel
                const ordersChannel = interaction.guild.channels.cache.find(c => c.name === 'orders');
                if (ordersChannel) {
                    const embed = new EmbedBuilder()
                        .setTitle(`✅ Order Confirmed`)
                        .setDescription(`**Order No:** ${order.orderNo}\n**Product:** ${order.product}\n**Quantity:** ${order.quantity}\n**Buyer:** <@${order.buyer}>`)
                        .setColor('#00C853')
                        .setFooter({ text: STORE_NAME })
                        .setTimestamp();
                    await ordersChannel.send({ embeds: [embed] });
                }

                await interaction.reply({ content: `✅ Order #${orderNo} confirmed!`, ephemeral: true });
                break;
            }

            case 'help': {
                const embed = new EmbedBuilder()
                    .setTitle(`📚 ${STORE_NAME} Commands`)
                    .setColor('#0099FF')
                    .addFields(
                        { name: '/setup', value: 'Setup server (Admin)' },
                        { name: '/vouch @user review', value: 'Vouch after purchase' },
                        { name: '/vouches', value: 'Check vouches' },
                        { name: '/product', value: 'Add product (Seller)' },
                        { name: '/stock', value: 'View all products' },
                        { name: '/orders', value: 'Check your orders' },
                        { name: '/confirm <orderno>', value: 'Confirm order (Staff)' },
                        { name: '/help', value: 'Show this menu' }
                    )
                    .setFooter({ text: STORE_NAME });
                await interaction.reply({ embeds: [embed], ephemeral: true });
                break;
            }

            case 'stats': {
                const vouches = loadData('vouches.json');
                const orders = loadData('orders.json');
                const products = loadData('products.json');
                const totalVouches = Object.values(vouches).reduce((a, b) => a + b.count, 0);
                const totalOrders = Object.keys(orders).length;

                const embed = new EmbedBuilder()
                    .setTitle(`📊 ${STORE_NAME} Stats`)
                    .addFields(
                        { name: '🛒 Products', value: `${Object.keys(products).length}`, inline: true },
                        { name: '🧾 Orders', value: `${totalOrders}`, inline: true },
                        { name: '⭐ Vouches', value: `${totalVouches}`, inline: true },
                        { name: '👥 Members', value: `${interaction.guild.memberCount}`, inline: true }
                    )
                    .setColor('#00E5FF')
                    .setFooter({ text: STORE_NAME });
                await interaction.reply({ embeds: [embed], ephemeral: true });
                break;
            }
        }
    } catch (err) {
        console.error('Command error:', err);
        if (!interaction.replied) await interaction.reply({ content: '❌ An error occurred!', ephemeral: true });
    }
});

// ==================== BUTTON & MODAL HANDLERS ====================
client.on('interactionCreate', async (interaction) => {
    // Buttons
    if (interaction.isButton()) {
        // Place Order
        if (interaction.customId === 'place_order') {
            const modal = new ModalBuilder()
                .setCustomId('order_modal')
                .setTitle(`🛒 ${STORE_NAME} - Place Order`);

            const productInput = new TextInputBuilder()
                .setCustomId('order_product')
                .setLabel('Product (e.g. Nitro Boost, Crunchyroll 6m)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const qtyInput = new TextInputBuilder()
                .setCustomId('order_qty')
                .setLabel('Quantity')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const priceInput = new TextInputBuilder()
                .setCustomId('order_price')
                .setLabel('Offer / Budget')
                .setStyle(TextInputStyle.Short)
                .setRequired(false);

            const notesInput = new TextInputBuilder()
                .setCustomId('order_notes')
                .setLabel('Notes (payment method, details)')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false);

            modal.addComponents(
                new ActionRowBuilder().addComponents(productInput),
                new ActionRowBuilder().addComponents(qtyInput),
                new ActionRowBuilder().addComponents(priceInput),
                new ActionRowBuilder().addComponents(notesInput)
            );
            await interaction.showModal(modal);
        }

        // Support ticket
        if (interaction.customId === 'support_ticket') {
            const ticketChannel = await interaction.guild.channels.create({
                name: `support-${interaction.user.username}`,
                type: ChannelType.GuildText,
                parent: interaction.guild.channels.cache.find(c => c.name.includes('SUPPORT'))?.id,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
                ]
            });

            const embed = new EmbedBuilder()
                .setTitle('🎧 Support Ticket')
                .setDescription(`Ticket created by ${interaction.user}\n\nDescribe your issue. Staff will help shortly.`)
                .setColor('#0099FF')
                .setFooter({ text: STORE_NAME });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
            );

            await ticketChannel.send({ content: `<@${interaction.user.id}>`, embeds: [embed], components: [row] });
            await interaction.reply({ content: `Ticket created: ${ticketChannel}`, ephemeral: true });
        }

        // Close ticket
        if (interaction.customId === 'close_ticket') {
            const embed = new EmbedBuilder()
                .setTitle('🔒 Ticket Closed')
                .setDescription(`Closed by ${interaction.user.tag}`)
                .setColor('#FF5555')
                .setFooter({ text: STORE_NAME });

            const logChannel = interaction.guild.channels.cache.find(c => c.name === 'ticket-logs');
            if (logChannel) await logChannel.send({ embeds: [embed] });
            await interaction.channel.delete();
        }

        // Buy product button
        if (interaction.customId.startsWith('buy_')) {
            const productId = interaction.customId.replace('buy_', '');
            const products = loadData('products.json');
            const product = products[productId];
            if (!product) return interaction.reply({ content: '❌ Product not found!', ephemeral: true });

            // Create order ticket
            orderCounter++;
            saveData('counter.json', { orderCounter });

            const orderNo = orderCounter;
            const orders = loadData('orders.json');
            const orderId = `order_${orderNo}`;
            orders[orderId] = {
                orderNo,
                product: product.name,
                price: product.price,
                quantity: 1,
                buyer: interaction.user.id,
                seller: product.seller,
                status: '⏳ Pending',
                createdAt: new Date().toISOString()
            };
            saveData('orders.json', orders);

            const ticketChannel = await interaction.guild.channels.create({
                name: `order-${orderNo}`,
                type: ChannelType.GuildText,
                parent: interaction.guild.channels.cache.find(c => c.name.includes('SUPPORT'))?.id,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                    { id: product.seller, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
                ]
            });

            const embed = new EmbedBuilder()
                .setTitle(`🧾 Order No: ${orderNo}`)
                .setDescription(`**Product:** ${product.name}\n**Price:** ${product.price}\n**Quantity:** 1\n**Buyer:** <@${interaction.user.id}>\n\nComplete payment with the seller to confirm your order.`)
                .setColor('#FF8800')
                .setFooter({ text: STORE_NAME })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`complete_${orderId}`).setLabel('✅ Mark Complete').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`vouch_${orderId}_${interaction.user.id}`).setLabel('⭐ Vouch').setStyle(ButtonStyle.Secondary).setEmoji('⭐'),
                new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 Close').setStyle(ButtonStyle.Danger)
            );

            await ticketChannel.send({ content: `<@${interaction.user.id}> <@${product.seller}>`, embeds: [embed], components: [row] });
            await interaction.reply({ content: `Order #${orderNo} created! Channel: ${ticketChannel}`, ephemeral: true });
        }

        // Complete order
        if (interaction.customId.startsWith('complete_')) {
            const orderId = interaction.customId.replace('complete_', '');
            const orders = loadData('orders.json');
            const order = orders[orderId];
            if (!order) return interaction.reply({ content: '❌ Order not found!', ephemeral: true });

            order.status = '✅ Completed';
            order.completedBy = interaction.user.id;
            order.completedAt = new Date().toISOString();
            saveData('orders.json', orders);

            // Post in orders channel
            const ordersChannel = interaction.guild.channels.cache.find(c => c.name === 'orders');
            if (ordersChannel) {
                const embed = new EmbedBuilder()
                    .setTitle('✅ Order Confirmed')
                    .setDescription(`**Order No:** ${order.orderNo}\n**Product:** ${order.product}\n**Quantity:** ${order.quantity}\n**Buyer:** <@${order.buyer}>`)
                    .setColor('#00C853')
                    .setFooter({ text: STORE_NAME })
                    .setTimestamp();
                await ordersChannel.send({ embeds: [embed] });
            }

            await interaction.reply({ content: `✅ Order #${order.orderNo} completed!`, ephemeral: true });

            // Invite buyer to vouch
            const vouchRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`vouch_${orderId}_${order.buyer}`).setLabel('⭐ Vouch Now').setStyle(ButtonStyle.Secondary).setEmoji('⭐')
            );
            const vouchPrompt = new EmbedBuilder()
                .setTitle('🎉 Order Complete!')
                .setDescription(`<@${order.buyer}>, your order **#${order.orderNo}** (${order.product}) is complete! 🎉\n\nClick **⭐ Vouch Now** to leave a vouch. Your vouch will automatically be posted in #vouches and logged in #orders!`)
                .setColor('#FFD700')
                .setFooter({ text: STORE_NAME });
            await interaction.channel.send({ embeds: [vouchPrompt], components: [vouchRow] });
        }

        // Vouch button in order ticket -> opens vouch modal
        if (interaction.customId.startsWith('vouch_')) {
            const parts = interaction.customId.split('_'); // vouch_{orderId}_{buyerId}
            const orderId = parts[1];
            const buyerId = parts[2];

            // Only allow the buyer of this order to vouch
            if (interaction.user.id !== buyerId) {
                return interaction.reply({ content: '❌ Only the buyer of this order can vouch!', ephemeral: true });
            }

            const orders = loadData('orders.json');
            const order = orders[orderId];
            if (!order) return interaction.reply({ content: '❌ Order not found!', ephemeral: true });

            const modal = new ModalBuilder()
                .setCustomId(`vouch_modal_${orderId}`)
                .setTitle('⭐ Leave a Vouch');

            const ratingInput = new TextInputBuilder()
                .setCustomId('vouch_rating')
                .setLabel('Rating (1-5)')
                .setStyle(TextInputStyle.Short)
                .setValue('5')
                .setRequired(true);

            const reviewInput = new TextInputBuilder()
                .setCustomId('vouch_review')
                .setLabel('Your review')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder(`How was buying ${order.product}?`)
                .setRequired(true);

            modal.addComponents(
                new ActionRowBuilder().addComponents(ratingInput),
                new ActionRowBuilder().addComponents(reviewInput)
            );

            await interaction.showModal(modal);
        }
    }

    // Modal submit (order)
    if (interaction.isModalSubmit()) {
        // Vouch modal submit -> posts to #vouches AND #orders
        if (interaction.customId.startsWith('vouch_modal_')) {
            const orderId = interaction.customId.replace('vouch_modal_', '');
            const orders = loadData('orders.json');
            const order = orders[orderId];
            if (!order) return interaction.reply({ content: '❌ Order not found!', ephemeral: true });

            const rating = interaction.fields.getTextInputValue('vouch_rating');
            const review = interaction.fields.getTextInputValue('vouch_review');

            const sellerId = order.seller;
            const seller = interaction.guild.members.cache.get(sellerId) || { user: { tag: `Seller <@${sellerId}>` } };
            const sellerTag = seller.user?.tag || `@${sellerId}`;

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
                review,
                date: new Date().toISOString()
            });
            saveData('vouches.json', vouches);

            // Mark order complete
            order.status = '✅ Completed (Vouched)';
            order.vouched = true;
            order.vouchReview = review;
            order.vouchRating = rating;
            order.completedAt = new Date().toISOString();
            saveData('orders.json', orders);

            const stars = '⭐'.repeat(Math.min(parseInt(rating) || 5, 5));

            // 1) Post vouch in #vouches
            const vouchEmbed = new EmbedBuilder()
                .setTitle('⭐ New Vouch!')
                .setDescription(`**${interaction.user.tag}** vouched for **${sellerTag}**`)
                .addFields(
                    { name: '🛒 Product', value: order.product, inline: true },
                    { name: '🧾 Order', value: `#${order.orderNo}`, inline: true },
                    { name: 'Rating', value: `${stars} (${rating}/5)` },
                    { name: '📝 Review', value: review },
                    { name: 'Total Vouches', value: `${vouches[sellerId].count}` }
                )
                .setColor('#FFD700')
                .setFooter({ text: STORE_NAME })
                .setTimestamp();

            const vouchChannel = interaction.guild.channels.cache.find(c => c.name === 'vouches');
            if (vouchChannel) {
                const vouchMsg = await vouchChannel.send({ embeds: [vouchEmbed] });
                await neonReact(vouchMsg, ['⭐', '✨', '✅', '🎉']).catch(() => {});
            }

            // 2) AUTOMATICALLY post "Order Completed" in #orders
            const ordersChannel = interaction.guild.channels.cache.find(c => c.name === 'orders');
            if (ordersChannel) {
                const completeEmbed = new EmbedBuilder()
                    .setTitle('✅ Order Completed')
                    .setDescription(`**Order No:** ${order.orderNo}\n**Product:** ${order.product}\n**Quantity:** ${order.quantity}\n**Buyer:** <@${interaction.user.id}>`)
                    .addFields(
                        { name: '⭐ Vouch', value: `${stars} · ${review}` },
                        { name: '🕒 Completed', value: `<t:${Math.floor(Date.now() / 1000)}:R>` }
                    )
                    .setColor('#00C853')
                    .setFooter({ text: STORE_NAME })
                    .setTimestamp();
                const orderMsg = await ordersChannel.send({ embeds: [completeEmbed] });
                await neonBurst(orderMsg).catch(() => {});
            }

            await interaction.reply({ content: `✅ Vouch submitted! Posted in #vouches and logged in #orders.`, ephemeral: true });
            return;
        }

        if (interaction.customId === 'order_modal') {
            const product = interaction.fields.getTextInputValue('order_product');
            const qty = interaction.fields.getTextInputValue('order_qty');
            const price = interaction.fields.getTextInputValue('order_price') || 'TBD';
            const notes = interaction.fields.getTextInputValue('order_notes') || 'None';

            orderCounter++;
            saveData('counter.json', { orderCounter });
            const orderNo = orderCounter;

            const orders = loadData('orders.json');
            const orderId = `order_${orderNo}`;
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

            const ticketChannel = await interaction.guild.channels.create({
                name: `order-${orderNo}`,
                type: ChannelType.GuildText,
                parent: interaction.guild.channels.cache.find(c => c.name.includes('SUPPORT'))?.id,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
                ]
            });

            const embed = new EmbedBuilder()
                .setTitle(`🧾 Order No: ${orderNo}`)
                .setDescription(`**Product:** ${product}\n**Quantity:** ${qty}\n**Offer:** ${price}\n**Notes:** ${notes}\n**Buyer:** <@${interaction.user.id}>\n\nA staff member will confirm your order shortly.`)
                .setColor('#FF8800')
                .setFooter({ text: STORE_NAME })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`complete_${orderId}`).setLabel('✅ Mark Complete').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`vouch_${orderId}_${interaction.user.id}`).setLabel('⭐ Vouch').setStyle(ButtonStyle.Secondary).setEmoji('⭐'),
                new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 Close').setStyle(ButtonStyle.Danger)
            );

            await ticketChannel.send({ content: `<@${interaction.user.id}>`, embeds: [embed], components: [row] });
            await interaction.reply({ content: `✅ Order #${orderNo} placed! Channel: ${ticketChannel}`, ephemeral: true });
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

    // Only detect messages that look like a vouch
    const text = message.content;
    const vouchKeywords = /(?:legit|rep|bought|vouch|purchased|trusted|positive)/i;
    if (!vouchKeywords.test(text)) return;

    // 1) Parse the seller - first mention, or snowflake ID in text, else store owner
    let sellerId = message.mentions.users.first()?.id;
    if (!sellerId) {
        const snowflake = text.match(/([0-9]{17,20})/);
        if (snowflake) sellerId = snowflake[1];
    }
    if (!sellerId) sellerId = config.ownerId; // fallback to store owner

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
        const words = p.split(/[ |[]/).filter(w => w.length > 0 && w.length < 20 && !/%/.test(w) && !/]/.test(w) && !stop.has(w.toLowerCase()));
        product = words.slice(0, 4).join(' ') || 'Unknown Product';
    }

    // 3) Parse the price
    let price = '';
    let m = text.match(/([0-9]+(?:[.][0-9]+)?)[ ]*(?:rs|rupees|inr|[$]|usd|dollars|euros|bucks)/i);
    if (!m) m = text.match(/[$][ ]*([0-9]+(?:[.][0-9]+)?)/);
    // fallback: a number right after "for/in/at" with no currency word (assume INR)
    if (!m) m = text.match(/(?:for|in|at)[ ]+([0-9]+(?:[.][0-9]+)?)/i);
    if (m) {
        const amount = m[1];
        if (/[$]|usd|dollars/i.test(m[0])) price = '$' + amount;
        else if (/euro/i.test(m[0])) price = 'EUR ' + amount;
        else price = 'INR ' + amount;
    }

    // 4) Generate order number
    orderCounter++;
    saveData('counter.json', { orderCounter });
    const orderNo = orderCounter;

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

    // 7) POST the "Order Completed" box in #orders (aesthetic design)
    const ordersChannel = message.guild.channels.cache.find(c => c.name === 'orders');
    if (ordersChannel) {
        const sellerTag = message.guild.members.cache.get(sellerId)?.user?.tag || (sellerId === config.ownerId ? STORE_NAME : 'Seller');
        const divider = '━━━━━━━━━━━━━━━━━━━━';
        const vouchText = text.length > 150 ? text.slice(0, 147) + '...' : text;
        const completeEmbed = new EmbedBuilder()
            .setTitle('✅ ORDER COMPLETED')
            .setDescription(
                divider + '\n' +
                `🧾 **Order No:**  #${orderNo}\n` +
                `🛒 **Item:**  ${product}\n` +
                `💲 **Price:**  ${price || 'N/A'}\n` +
                `👤 **Buyer:**  <@${message.author.id}>\n` +
                `🛍️ **Seller:**  ${sellerTag}\n` +
                divider
            )
            .addFields(
                { name: '⭐ Vouch', value: '> ' + vouchText },
                { name: '🕒 Completed', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
                { name: '🧾 Order No', value: `#${orderNo}`, inline: true }
            )
            .setColor('#00C853')
            .setFooter({ text: `${STORE_NAME} · Confirmed Order` })
            .setTimestamp();
        const completeMsg = await ordersChannel.send({ embeds: [completeEmbed] });
        await neonBurst(completeMsg).catch(() => {});
    }

    // 8) Confirm to the buyer + add a vouch reaction embed
    const vouchEmbed = new EmbedBuilder()
        .setTitle('⭐ Vouch Logged')
        .setDescription(`Vouch submitted for **${product}** - **${price || 'N/A'}**`)
        .addFields(
            { name: '🧾 Order No', value: `#${orderNo}`, inline: true },
            { name: '👤 Buyer', value: `<@${message.author.id}>`, inline: true }
        )
        .setColor('#FFD700')
        .setFooter({ text: `${STORE_NAME} · Vouch #${vouches[sellerId].count}` });
    const confirmMsg = await message.channel.send({ embeds: [vouchEmbed] });

    // NEON ANIMATED REACTIONS - cascade on the user's vouch + the confirmation
    await neonReact(message, ['⭐', '✨', '✅', '🎉']).catch(() => {});
    await neonBurst(confirmMsg).catch(() => {});
});

// ==================== WELCOME ====================
client.on('guildMemberAdd', async (member) => {
    const welcomeChannel = member.guild.channels.cache.find(c => c.name === 'welcome-back');
    if (!welcomeChannel) return;

    const embed = new EmbedBuilder()
        .setTitle(`👋 Welcome, ${member.user.username}!`)
        .setDescription(`Welcome to ${STORE_NAME}!\n\n` +
            `**🛒** Check our shops for the latest stock\n` +
            `**✅** Trusted by 100+ customers - check our vouches in <#${member.guild.channels.cache.find(c => c.name === 'vouches')?.id || 'vouches'}>\n` +
            `**🧾** Every order confirmed in <#${member.guild.channels.cache.find(c => c.name === 'orders')?.id || 'orders'}>\n` +
            `**💬** Chat with us in <#${member.guild.channels.cache.find(c => c.name === 'general-chat')?.id || 'general-chat'}>\n` +
            `**🎫** Want to buy? Create an order!\n\n` +
            `Read the rules in <#${member.guild.channels.cache.find(c => c.name === 'rules')?.id || 'rules'}>!`)
        .setThumbnail(member.user.displayAvatarURL())
        .setImage('https://media.tenor.com/EWwYmIsWKroAAAAM/kaneki-tokyo-ghoul.gif')
        .setColor('#00C853')
        .setFooter({ text: STORE_NAME })
        .setTimestamp();

    await welcomeChannel.send({ content: `Welcome <@${member.user.id}>! 🎉`, embeds: [embed] });

    // Auto-assign Member role
    const memberRole = member.guild.roles.cache.find(r => r.name === 'Member');
    if (memberRole) await member.roles.add(memberRole).catch(() => {});
});

// Login (supports env var TOKEN / DISCORD_TOKEN for cloud hosting)
if (process.env.TOKEN || process.env.DISCORD_TOKEN) {
    config.token = process.env.TOKEN || process.env.DISCORD_TOKEN;
    console.log('Using token from environment variable.');
}
if (!config.token || config.token === 'YOUR_BOT_TOKEN_HERE') {
    console.error('❌ Please set your bot token in config.json (or TOKEN env var)!');
    process.exit(1);
}
client.login(config.token);
