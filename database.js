import { Client, GatewayIntentBits, PermissionsBitField, AttachmentBuilder, EmbedBuilder } from 'discord.js';
import config from './config.js';
import { RAGApplicationBuilder, PdfLoader, OpenAi } from '@llm-tools/embedjs';
import { LanceDb } from '@llm-tools/embedjs/vectorDb/lance';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';

process.env.ANTHROPIC_API_KEY = config.claudeApiKey;
process.env.OPENAI_API_KEY = config.openaiApiKey;
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

let db = null;

const initDatabase = async () => {
    db = await open({
        filename: './messageHistory.db',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS messageHistory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            roomId TEXT,
            userId TEXT,
            role TEXT,
            content TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            deleted BOOLEAN DEFAULT 0
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS campaignSummary (
            roomId TEXT PRIMARY KEY,
            summary TEXT,
            lastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS characterProfiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            roomId TEXT,
            userId TEXT,
            characterName TEXT,
            characterData TEXT,
            lastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS channelConfig (
            roomId TEXT PRIMARY KEY,
            role TEXT,
            lastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
};

await initDatabase();

const ragAppPromises = new Map();

export const initRAGApplication = (roomId, options = { loadMonsterManual: false, loadPlayersHandbook: false }) => {
    if (ragAppPromises.has(roomId)) {
        return ragAppPromises.get(roomId);
    }

    const ragAppPromise = (async () => {
        console.log(`Initializing RAG Application for room ${roomId}...`);
        const path = './db';

        if (!fs.existsSync(path)) {
            fs.mkdirSync(path);
            console.log('Database directory created.');
        } else {
            console.log('Database directory already exists.');
        }
        const ragApp = await new RAGApplicationBuilder()
            .setModel(new OpenAi({
                modelName: 'gpt-4o-mini'
            }))
            .setVectorDb(new LanceDb({ path: `./db/room${roomId}` }))
            .build();
        console.log(`RAG Application initialized for room ${roomId}.`);

        if (options.loadMonsterManual) {
            console.log('Loading Monster Manual into RAG Application...');
            await ragApp.addLoader(new PdfLoader({ filePathOrUrl: './monster_manual.pdf' }))
                .then(() => console.log('Monster Manual loaded into RAG Application.'))
                .catch((error) => console.error('Error loading Monster Manual:', error));
        }

        if (options.loadPlayersHandbook) {
            console.log('Loading Players Handbook into RAG Application...');
            await ragApp.addLoader(new PdfLoader({ filePathOrUrl: './players_handbook.pdf' }))
                .then(() => console.log('Players Handbook loaded into RAG Application.'))
                .catch((error) => console.error('Error loading Players Handbook:', error));
        }

        return ragApp;
    })();

    ragAppPromises.set(roomId, ragAppPromise);
    return ragAppPromise;
};

export const storeMessage = async (roomId, userId, role, content) => {
    await db.run(`
        INSERT INTO messageHistory (roomId, userId, role, content)
        VALUES (?, ?, ?, ?)
    `, [roomId, userId, role, content]);
};

export const getRoomHistory = async (roomId) => {
    return await db.all(`
        SELECT * FROM messageHistory
        WHERE roomId = ? AND deleted = 0
        ORDER BY timestamp ASC
    `, [roomId]);
};

export const markOldestMessagesAsDeleted = async (roomId, limit) => {
    const oldestMessages = await db.all(`
        SELECT id FROM messageHistory
        WHERE roomId = ? AND deleted = 0
        ORDER BY timestamp ASC
        LIMIT ?
    `, [roomId, limit]);

    const idsToMark = oldestMessages.map(msg => msg.id);
    if (idsToMark.length > 0) {
        await db.run(`
            UPDATE messageHistory
            SET deleted = 1
            WHERE id IN (${idsToMark.join(',')})
        `);
    }
};

export const getCampaignSummary = async (roomId) => {
    const result = await db.get(`
        SELECT summary FROM campaignSummary
        WHERE roomId = ?
    `, [roomId]);
    return result ? result.summary : '';
};

export const storeCampaignSummary = async (roomId, summary) => {
    await db.run(`
        INSERT INTO campaignSummary (roomId, summary, lastUpdated)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(roomId) DO UPDATE SET summary = excluded.summary, lastUpdated = excluded.lastUpdated
    `, [roomId, summary]);
};

export const storeCharacterProfile = async (roomId, userId, characterName, characterData) => {
    await db.run(`
        INSERT INTO characterProfiles (roomId, userId, characterName, characterData, lastUpdated)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(roomId, userId, characterName) DO UPDATE SET characterData = excluded.characterData, lastUpdated = excluded.lastUpdated
    `, [roomId, userId, characterName, characterData]);
};

export const getCharacterProfiles = async (roomId) => {
    return await db.all(`
        SELECT * FROM characterProfiles
        WHERE roomId = ?
    `, [roomId]);
};

export const getChannelRole = async (roomId) => {
    const result = await db.get(`
        SELECT role FROM channelConfig
        WHERE roomId = ?
    `, [roomId]);
    return result ? result.role : null;
};

export const storeChannelRole = async (roomId, role) => {
    await db.run(`
        INSERT INTO channelConfig (roomId, role, lastUpdated)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(roomId) DO UPDATE SET role = excluded.role, lastUpdated = excluded.lastUpdated
    `, [roomId, role]);
};
