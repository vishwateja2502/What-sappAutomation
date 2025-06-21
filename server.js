const express = require('express');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Store client instance and QR code
let client = null;
let qrCodeData = null;
let isAuthenticated = false;

// Scheduled messages storage
let scheduledMessages = new Map();
let scheduledJobs = new Map();
let activityLog = []; // New log storage

// File paths
const SCHEDULED_MESSAGES_FILE = './scheduled_messages.json';
const ACTIVITY_LOG_FILE = './activity_log.json';
const MAX_LOG_ENTRIES = 50;

function loadScheduledMessages() {
    try {
        if (fs.existsSync(SCHEDULED_MESSAGES_FILE)) {
            const data = fs.readFileSync(SCHEDULED_MESSAGES_FILE, 'utf8');
            const messages = JSON.parse(data);
            scheduledMessages = new Map(Object.entries(messages));
            
            // Restore scheduled jobs
            scheduledMessages.forEach((messageData, id) => {
                if (messageData.scheduledTime > Date.now()) {
                    scheduleMessage(id, messageData);
                }
            });
            
            console.log(`Loaded ${scheduledMessages.size} scheduled messages`);
        }
    } catch (error) {
        console.error('Error loading scheduled messages:', error);
    }
}

function saveScheduledMessages() {
    try {
        const data = Object.fromEntries(scheduledMessages);
        fs.writeFileSync(SCHEDULED_MESSAGES_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error saving scheduled messages:', error);
    }
}

function loadActivityLog() {
    try {
        if (fs.existsSync(ACTIVITY_LOG_FILE)) {
            const data = fs.readFileSync(ACTIVITY_LOG_FILE, 'utf8');
            activityLog = JSON.parse(data);
            console.log(`Loaded ${activityLog.length} log entries.`);
        }
    } catch (error) {
        console.error('Error loading activity log:', error);
    }
}

function saveActivityLog() {
    try {
        fs.writeFileSync(ACTIVITY_LOG_FILE, JSON.stringify(activityLog, null, 2));
    } catch (error) {
        console.error('Error saving activity log:', error);
    }
}

function addLogEntry(message) {
    const newEntry = {
        timestamp: Date.now(),
        message: message,
    };
    activityLog.unshift(newEntry); // Add to the beginning

    // Keep the log size manageable
    if (activityLog.length > MAX_LOG_ENTRIES) {
        activityLog.pop();
    }

    saveActivityLog();
}

function scheduleMessage(id, messageData) {
    const scheduledTime = new Date(messageData.scheduledTime);
    const now = new Date();
    
    if (scheduledTime <= now) {
        // Message is already due, send immediately
        sendScheduledMessage(id, messageData);
        return;
    }
    
    // Calculate delay in milliseconds
    const delay = scheduledTime.getTime() - now.getTime();
    
    // Schedule the message
    const timeoutId = setTimeout(() => {
        sendScheduledMessage(id, messageData);
    }, delay);
    
    scheduledJobs.set(id, timeoutId);
    
    console.log(`Scheduled message ${id} for ${scheduledTime.toLocaleString()}`);
}

async function sendScheduledMessage(id, messageData) {
    try {
        if (!client || !isAuthenticated) {
            console.log(`Cannot send scheduled message ${id}: WhatsApp not authenticated`);
            return;
        }
        
        console.log(`Sending scheduled message ${id} to ${messageData.recipients.length} recipients`);
        
        const results = [];
        let successCount = 0;
        
        for (const recipient of messageData.recipients) {
            const chatId = `${recipient.number}@c.us`;
            
            try {
                const message = messageData.messageTemplate.replace(/{name}/g, recipient.name);
                await client.sendMessage(chatId, message);
                
                results.push({
                    name: recipient.name,
                    number: recipient.number,
                    status: 'success',
                    message: 'Message sent successfully'
                });
                successCount++;
                
                // Add delay between messages
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                results.push({
                    name: recipient.name,
                    number: recipient.number,
                    status: 'error',
                    message: error.message
                });
            }
        }
        
        const summaryMessage = `Scheduled job completed: ${successCount}/${messageData.recipients.length} messages sent successfully.`;
        console.log(summaryMessage);
        addLogEntry(summaryMessage);
        
        // Remove from scheduled messages
        scheduledMessages.delete(id);
        scheduledJobs.delete(id);
        saveScheduledMessages();
        
    } catch (error) {
        console.error(`Error sending scheduled message ${id}:`, error);
        addLogEntry(`Error processing scheduled job ${id}: ${error.message}`);
    }
}

// Cleanup function
function cleanupSession() {
    const sessionDir = './whatsapp-session';
    if (fs.existsSync(sessionDir)) {
        try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            console.log('Cleaned up previous session directory');
        } catch (error) {
            console.log('Error cleaning session directory:', error.message);
        }
    }
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Initialize WhatsApp client
app.post('/api/init', async (req, res) => {
    try {
        if (client) {
            try {
                await client.destroy();
            } catch (destroyError) {
                console.log('Error destroying previous client:', destroyError.message);
            }
            client = null;
        }

        // Clean up previous session
        cleanupSession();

        client = new Client({
            authStrategy: new LocalAuth(),
            webVersion: '2.2412.54',
            webVersionCache: {
              type: 'remote',
              remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
            },
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                ],
                timeout: 120000 // Increased timeout to 2 minutes
            }
        });

        client.on('qr', async (qr) => {
            try {
                // Generate QR code as data URL
                qrCodeData = await qrcode.toDataURL(qr);
                console.log('QR Code generated');
            } catch (error) {
                console.error('Error generating QR code:', error);
            }
        });

        client.on('ready', () => {
            isAuthenticated = true;
            qrCodeData = null; // Clear QR code data
            console.log('✅ You are logged in successfully.');
        });

        client.on('disconnected', (reason) => {
            isAuthenticated = false;
            qrCodeData = null;
            console.log('WhatsApp client disconnected:', reason);
        });

        // Add retry logic for network issues
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
            try {
                console.log(`Attempting to initialize WhatsApp client (attempt ${retryCount + 1}/${maxRetries})`);
                await client.initialize();
                break; // Success, exit retry loop
            } catch (error) {
                retryCount++;
                console.error(`Attempt ${retryCount} failed:`, error.message);
                
                if (error.message.includes('ERR_INTERNET_DISCONNECTED') || 
                    error.message.includes('ERR_NETWORK') ||
                    error.message.includes('ERR_CONNECTION') ||
                    error.message.includes('Session closed')) {
                    
                    if (retryCount < maxRetries) {
                        console.log(`Network/Session error detected. Retrying in 5 seconds...`);
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        continue;
                    } else {
                        throw new Error(`Failed to connect after ${maxRetries} attempts. Please check your internet connection.`);
                    }
                } else {
                    // Non-network error, don't retry
                    throw error;
                }
            }
        }
        
        res.json({ success: true, message: 'Client initialized' });
    } catch (error) {
        console.error('Error initializing client:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get QR code
app.get('/api/qr', (req, res) => {
    if (!client) {
        return res.status(400).json({ success: false, error: 'Client not initialized' });
    }

    if (isAuthenticated) {
        return res.json({ success: true, authenticated: true });
    }

    if (qrCodeData) {
        return res.json({ success: true, qrCode: qrCodeData });
    }

    res.json({ success: true, message: 'Waiting for QR code...' });
});

// Send messages
app.post('/api/send', async (req, res) => {
    try {
        const { recipients, messageTemplate } = req.body;

        if (!client || !isAuthenticated) {
            return res.status(400).json({ success: false, error: 'You must connect to WhatsApp before proceeding.' });
        }

        if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
            return res.status(400).json({ success: false, error: 'No recipients provided' });
        }

        const results = [];
        let successCount = 0;

        for (let i = 0; i < recipients.length; i++) {
            const recipient = recipients[i];
            const chatId = `${recipient.number}@c.us`;
            
            try {
                const message = messageTemplate.replace(/{name}/g, recipient.name);
                await client.sendMessage(chatId, message);
                
                results.push({
                    name: recipient.name,
                    number: recipient.number,
                    status: 'success',
                    message: 'Message sent successfully'
                });
                successCount++;
                
                // Add delay between messages
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                results.push({
                    name: recipient.name,
                    number: recipient.number,
                    status: 'error',
                    message: error.message
                });
            }
        }

        res.json({
            success: true,
            results,
            summary: {
                total: recipients.length,
                successful: successCount,
                failed: recipients.length - successCount
            }
        });

    } catch (error) {
        console.error('Error sending messages:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Check authentication status
app.get('/api/status', (req, res) => {
    res.json({
        authenticated: isAuthenticated,
        clientExists: !!client
    });
});

// Schedule messages
app.post('/api/schedule', async (req, res) => {
    try {
        const { recipients, messageTemplate, scheduledTime, timezone } = req.body;

        if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
            return res.status(400).json({ success: false, error: 'No recipients provided' });
        }

        if (!messageTemplate) {
            return res.status(400).json({ success: false, error: 'No message template provided' });
        }

        if (!scheduledTime) {
            return res.status(400).json({ success: false, error: 'No scheduled time provided' });
        }

        // Convert scheduled time to server timezone
        let targetTime;
        try {
            // The scheduledTime string is "YYYY-MM-DDTHH:mm", e.g., "2025-06-20T23:00".
            // This time is always intended to be in IST.

            // We manually parse the string to avoid any browser/server timezone ambiguity.
            const parts = scheduledTime.split('T');
            const dateParts = parts[0].split('-');
            const timeParts = parts[1].split(':');

            // We construct a Date object as if the time was in UTC.
            // Note: JavaScript months are 0-indexed, so we subtract 1.
            const dateAsUTC = new Date(Date.UTC(
                parseInt(dateParts[0], 10),     // year
                parseInt(dateParts[1], 10) - 1, // month
                parseInt(dateParts[2], 10),     // day
                parseInt(timeParts[0], 10),     // hour
                parseInt(timeParts[1], 10)      // minute
            ));

            // Now we have a UTC timestamp that matches the numbers of the IST time.
            // To get the *actual* UTC time, we must subtract the IST offset (5.5 hours).
            const istOffsetMilliseconds = (5 * 60 + 30) * 60 * 1000;
            targetTime = dateAsUTC.getTime() - istOffsetMilliseconds;

        } catch (error) {
            console.error("Error parsing scheduled time:", error);
            return res.status(400).json({ success: false, error: 'Invalid scheduled time format' });
        }

        // Check if time is in the future
        if (targetTime <= Date.now()) {
            return res.status(400).json({ success: false, error: 'Scheduled time must be in the future' });
        }

        // Generate unique ID for the scheduled message
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const messageData = {
            recipients,
            messageTemplate,
            scheduledTime: targetTime,
            timezone,
            createdAt: Date.now(),
            status: 'scheduled'
        };

        // Store the scheduled message
        scheduledMessages.set(messageId, messageData);
        saveScheduledMessages();

        // Schedule the message
        scheduleMessage(messageId, messageData);

        res.json({
            success: true,
            messageId,
            scheduledTime: new Date(targetTime).toISOString(),
            message: `Message scheduled for ${new Date(targetTime).toLocaleString()}`
        });

    } catch (error) {
        console.error('Error scheduling message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get scheduled messages
app.get('/api/scheduled', (req, res) => {
    try {
        const scheduledList = Array.from(scheduledMessages.entries()).map(([id, data]) => ({
            id,
            scheduledTime: new Date(data.scheduledTime).toISOString(),
            timezone: data.timezone,
            recipientCount: data.recipients.length,
            messagePreview: data.messageTemplate.substring(0, 100) + (data.messageTemplate.length > 100 ? '...' : ''),
            status: data.status,
            createdAt: new Date(data.createdAt).toISOString()
        }));

        res.json({
            success: true,
            scheduledMessages: scheduledList
        });

    } catch (error) {
        console.error('Error getting scheduled messages:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Cancel scheduled message
app.delete('/api/scheduled/:id', (req, res) => {
    try {
        const messageId = req.params.id;

        if (!scheduledMessages.has(messageId)) {
            return res.status(404).json({ success: false, error: 'Scheduled message not found' });
        }

        // Cancel the scheduled job
        const timeoutId = scheduledJobs.get(messageId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            scheduledJobs.delete(messageId);
        }

        // Remove from storage
        scheduledMessages.delete(messageId);
        saveScheduledMessages();

        addLogEntry(`Cancelled scheduled message: ${messageId}`);

        res.json({
            success: true,
            message: 'Scheduled message cancelled successfully'
        });

    } catch (error) {
        console.error('Error cancelling scheduled message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/logs', (req, res) => {
    res.json({ success: true, logs: activityLog });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log('📱 WhatsApp Bulk Message Sender is ready!');
    
    // Load persisted data on startup
    loadScheduledMessages();
    loadActivityLog();
}); 

function showStatus(message, type = 'info') {
    const container = document.getElementById('statusContainer');
    container.innerHTML = ''; // Clear previous status
    const status = document.createElement('div');
    status.className = `status ${type}`;
    status.textContent = message;
    container.appendChild(status);
} 