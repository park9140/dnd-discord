import { Client, GatewayIntentBits } from 'discord.js';
import config from './config.js';
import { handleDndMessage } from './handlers/dnd-handler.js';
import { handleAssistantMessage } from './handlers/assistant-handler.js';
import { storeChannelRole, getChannelRole } from './database.js';

process.env.ANTHROPIC_API_KEY = config.claudeApiKey;
process.env.OPENAI_API_KEY = config.openaiApiKey;
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('ready', async () => {
    console.log('Bot is ready!');
    client.userId = client.user.id;
    console.log(`Bot user ID: ${client.userId}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const botMention = `<@${client.userId}>`;
    if (message.content.startsWith(botMention)) {
        const command = message.content.slice(botMention.length).trim();
        if (command.startsWith('setrole:')) {
            const mode = command.split('setrole:')[1].trim();
            await storeChannelRole(message.guild.id, mode);
            message.channel.send(`Role set to ${mode}`);
            return;
        }
    }

    const roomRole = await getChannelRole(message.guild.id);
    if (roomRole) {
        switch (roomRole) {
            case 'gm':
                handleDndMessage(message, message.guild.id, client.userId, client);
                break;
            case 'assistant':
                handleAssistantMessage(message, message.guild.id, message.author.id, client);
                break;
            default:
                console.log(`No handler for role: ${roomRole}`);
        }
    }
});

console.log('Logging in bot...');
client.login(config.token);
console.log('Bot logged in.');
