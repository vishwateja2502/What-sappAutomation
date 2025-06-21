// 🚀 Starting point
console.log("🚀 Starting WhatsApp automation...");

const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

// Phone numbers configuration with names
const RECIPIENTS = [
    { name: 'Lohith', number: '919459664555' },
    { name: 'Akshay', number: '916281558105' },
    { name: 'Harshi', number: '919550812359' }
];

// Function to create personalized message
const createMessage = (name) => {
    return `Hey ${name}! 👋\n\nThis is a personalized test message sent via WhatsApp automation.\n\nHave a great day! 😊`;
};

// Track message status
let messagesSent = 0;
let messagesDelivered = 0;
const messageStatus = new Map();

// Create WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-accelerated-2d-canvas'
        ],
        timeout: 100000
    }
});

// Handle QR Code
client.on('qr', (qr) => {
    console.log('\n🔄 QR Code received. Please scan with WhatsApp:\n');
    qrcode.generate(qr, { small: true });
});

// Loading screen
client.on('loading_screen', (percent, message) => {
    console.log('🔄 Loading:', percent, '%', message);
});

// Client is authenticating
client.on('authenticated', () => {
    console.log('\n✅ Successfully authenticated!\n');
});

// Authentication failed
client.on('auth_failure', (err) => {
    console.error('❌ Authentication failed:', err);
    process.exit(1);
});

// When client is ready
client.on('ready', async () => {
    console.log('\n✅ WhatsApp client is ready!');
    console.log(`\n📱 Preparing to send personalized messages to ${RECIPIENTS.length} contacts...\n`);

    try {
        // Send messages to all recipients
        for (let i = 0; i < RECIPIENTS.length; i++) {
            const recipient = RECIPIENTS[i];
            const chatId = `${recipient.number}@c.us`;
            
            try {
                console.log(`\n[${i + 1}/${RECIPIENTS.length}] 📤 Sending to ${recipient.name} (${recipient.number})...`);
                
                const personalizedMessage = createMessage(recipient.name);
                const msg = await client.sendMessage(chatId, personalizedMessage);
                
                messageStatus.set(msg.id._serialized, {
                    name: recipient.name,
                    number: recipient.number,
                    status: 'sent',
                    timestamp: new Date()
                });
                messagesSent++;
                
                console.log(`✅ Message sent to ${recipient.name}`);
                
                // Add a small delay between messages to prevent flooding
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`❌ Failed to send to ${recipient.name} (${recipient.number}):`, error.message);
            }
        }

        console.log('\n📊 Summary:');
        console.log(`✅ ${messagesSent} messages sent successfully`);
        console.log(`❌ ${RECIPIENTS.length - messagesSent} messages failed`);

        // Monitor delivery status for 30 seconds before exiting
        console.log('\n⏳ Monitoring delivery status for 30 seconds...');
        
        setTimeout(() => {
            console.log('\n📊 Final Delivery Status:');
            messageStatus.forEach((status, id) => {
                console.log(`${status.name} (${status.number}): ${status.status}`);
            });
            process.exit(0);
        }, 30000);

    } catch (error) {
        console.error('\n❌ Error in bulk sending:', error);
        process.exit(1);
    }
});

// Track message delivery status
client.on('message_ack', (msg) => {
    if (messageStatus.has(msg.id._serialized)) {
        const status = messageStatus.get(msg.id._serialized);
        const states = ['sent', 'delivered', 'read'];
        status.status = states[msg.ack] || 'unknown';
        messageStatus.set(msg.id._serialized, status);
        
        if (msg.ack >= 1 && !status.delivered) {
            status.delivered = true;
            messagesDelivered++;
            console.log(`📱 Message to ${status.name} is now ${status.status}`);
        }
    }
});

// Connection events
client.on('disconnected', (reason) => {
    console.log('❌ Client was disconnected:', reason);
    process.exit(1);
});

// Initialize
console.log('\n🚀 Starting WhatsApp bulk message sender...');
console.log('Please wait while we initialize the client...\n');

client.initialize().catch(err => {
    console.error('❌ Failed to initialize client:', err);
    process.exit(1);
});
