/**
 * Lightweight Socket.IO server for real-time 1:1 chat.
 * Designed to run separately from Next.js (e.g. Render/Railway/VPS).
 *
 * Environment:
 * - PORT (default 4001)
 * - DATABASE_URL (shared with Next app)
 * - JWT_SECRET (shared with Next app)
 * - CORS_ORIGIN (comma-separated origins allowed for websocket)
 *
 * This server:
 * - Authenticates users via JWT from cookie `token` or `auth.token` payload.
 * - Tracks online users in-memory (userId -> socketIds).
 * - Broadcasts presence (user_online / user_offline with lastSeenAt).
 * - Handles join_chat / leave_chat, send_message (with DB persistence for text),
 *   and typing indications.
 *
 * NOTE: For attachments, persist them through the existing REST API and emit
 *       `send_message` with `persistedMessage` to fan-out in real time.
 */

const { createServer } = require('node:http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const PORT = process.env.PORT || 4001;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((v) => v.trim());

console.log('Socket server JWT_SECRET preview:', JWT_SECRET.substring(0, 10) + '...');
console.log('Socket server CORS_ORIGIN:', ALLOWED_ORIGINS);

const httpServer = createServer((req, res) => {
  // Handle POST requests to /emit for triggering socket events
  if (req.method === 'POST' && req.url === '/emit') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const { event, data } = JSON.parse(body);

        if (event === 'mark_messages_read') {
          // Handle the mark_messages_read event
          const { chatId, userId, updatedMessageIds } = data;

          // Verify the user has access to this chat (optional, for security)
          ensureChatAccess(chatId, userId).then(chat => {
            if (chat) {
              // Send message status update to all participants in the chat
              io.to(`chat:${chatId}`).emit('message_status_update', {
                chatId,
                messageIds: updatedMessageIds,
                status: 'read',
                updatedBy: userId,
              });
              console.log(`Broadcasted message status update for chat ${chatId}: ${updatedMessageIds.length} messages marked as read`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            } else {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Forbidden' }));
            }
          }).catch(err => {
            console.error('Error in /emit:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          });
        } else if (event === 'message_delivered') {
          // Handle the message_delivered event
          const { messageIds, userId } = data;

          // Get chat IDs for the messages to send updates to correct chat rooms
          prisma.message.findMany({
            where: { id: { in: messageIds } },
            select: { id: true, chatId: true },
          }).then(messages => {
            // Group messages by chatId
            const chatMessages = {};
            messages.forEach(msg => {
              if (!chatMessages[msg.chatId]) {
                chatMessages[msg.chatId] = [];
              }
              chatMessages[msg.chatId].push(msg.id);
            });

            // Send message status update for each chat
            Object.entries(chatMessages).forEach(([chatId, msgIds]) => {
              io.to(`chat:${chatId}`).emit('message_status_update', {
                chatId,
                messageIds: msgIds,
                status: 'delivered',
                updatedBy: userId,
              });
            });

            console.log(`Broadcasted message delivered status for ${messageIds.length} messages`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          }).catch(err => {
            console.error('Error in message_delivered:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          });
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unsupported event' }));
        }
      } catch (err) {
        console.error('Error parsing request body:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Socket server is running');
  }
});

const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    credentials: true,
  },
  transports: ['websocket'],
});

// userId -> { sockets: Set<socketId>, lastSeenAt?: Date }
const onlineUsers = new Map();

function parseTokenFromHandshake(handshake) {
  const authToken =
    handshake.auth?.token ||
    handshake.query?.token ||
    handshake.headers?.token ||
    null;

  // Try cookies as fallback
  if (authToken) return authToken;

  const rawCookie = handshake.headers?.cookie;
  if (!rawCookie) return null;
  const parsed = cookie.parse(rawCookie || '');
  return parsed.token || null;
}

function verifyAuth(token) {
  if (!token) return null;
  try {
    console.log('Verifying token:', token.substring(0, 50) + '...');
    console.log('JWT_SECRET length:', JWT_SECRET.length);
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('Decoded payload:', decoded);
    if (!decoded?.userId) {
      console.log('No userId in payload');
      return null;
    }
    return decoded;
  } catch (err) {
    console.log('JWT verification error:', err.message);
    return null;
  }
}

async function ensureChatAccess(chatId, userId) {
  if (!chatId || !userId) return null;
  const chat = await prisma.chat.findFirst({
    where: {
      id: chatId,
      OR: [{ buyerId: userId }, { sellerId: userId }],
    },
    select: {
      id: true,
      buyerId: true,
      sellerId: true,
    },
  });
  return chat;
}

async function getRelevantUsers(userId) {
  if (!userId) return [];

  try {
    // Получаем всех собеседников пользователя из активных чатов
    const chats = await prisma.chat.findMany({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
      },
      select: {
        buyerId: true,
        sellerId: true,
      },
    });

    // Извлекаем уникальных собеседников (исключая самого пользователя)
    const relevantUsers = new Set();
    chats.forEach(chat => {
      if (chat.buyerId !== userId) relevantUsers.add(chat.buyerId);
      if (chat.sellerId !== userId) relevantUsers.add(chat.sellerId);
    });

    return Array.from(relevantUsers);
  } catch (error) {
    console.error('Error getting relevant users:', error);
    return [];
  }
}

io.on('connection', async (socket) => {
  console.log('New socket connection attempt:', socket.id);

  const token = parseTokenFromHandshake(socket.handshake);

  console.log('Token from handshake:', token ? 'present' : 'missing');

  const payload = verifyAuth(token);

  console.log('Auth payload:', payload ? { userId: payload.userId } : 'null');

  if (!payload) {
    console.log('Authentication failed, disconnecting socket');
    socket.emit('auth_error', { reason: 'unauthorized' });
    socket.disconnect(true);
    return;
  }

  const userId = Number(payload.userId);
  socket.data.userId = userId;
  console.log(`User ${userId} authenticated successfully`);

  // Presence: mark online
  const state = onlineUsers.get(userId) || { sockets: new Set(), lastSeenAt: null };
  state.sockets.add(socket.id);
  onlineUsers.set(userId, state);

  // Join personal room for presence fan-out
  socket.join(`user:${userId}`);

  // Notify relevant users that this user is online
  const relevantUsersOnline = await getRelevantUsers(userId);
  relevantUsersOnline.forEach(relevantUserId => {
    io.to(`user:${relevantUserId}`).emit('user_online', { userId });
  });
  console.log(`User ${userId} is now online, notified ${relevantUsersOnline.length} relevant users`);

  // Send snapshot of relevant online users to THIS client only
  const relevantUsers = await getRelevantUsers(userId);
  const onlineRelevantUsers = relevantUsers.filter(userId => onlineUsers.has(userId));

  socket.emit('presence_snapshot', {
    onlineUserIds: onlineRelevantUsers,
  });
  console.log(`Sent relevant presence snapshot to ${userId}:`, onlineRelevantUsers);

  socket.on('join_chat', async ({ chatId }) => {
    if (!chatId) return;
    const chat = await ensureChatAccess(chatId, userId);
    if (!chat) {
      socket.emit('join_error', { chatId, reason: 'forbidden' });
      return;
    }
    socket.join(`chat:${chatId}`);
    socket.emit('chat_joined', { chatId });
  });

  socket.on('leave_chat', ({ chatId }) => {
    if (!chatId) return;
    socket.leave(`chat:${chatId}`);
  });

  socket.on(
    'typing',
    ({ chatId }) => {
      if (!chatId) return;
      socket.to(`chat:${chatId}`).emit('typing', {
        chatId,
        fromUserId: userId,
        at: Date.now(),
      });
    }
  );

  socket.on(
    'stop_typing',
    ({ chatId }) => {
      if (!chatId) return;
      socket.to(`chat:${chatId}`).emit('stop_typing', {
        chatId,
        fromUserId: userId,
        at: Date.now(),
      });
    }
  );

  socket.on(
    'send_message',
    async ({ chatId, content, tempId, persistedMessage }) => {
      if (!chatId) return;
      const chat = await ensureChatAccess(chatId, userId);
      if (!chat) {
        socket.emit('message_error', { chatId, tempId, reason: 'forbidden' });
        return;
      }

      // If message already persisted (e.g., with attachments via REST)
      if (persistedMessage) {
        io.to(`chat:${chatId}`).emit('new_message', {
          ...persistedMessage,
          tempId,
        });
        socket.emit('message_saved', {
          tempId,
          message: persistedMessage,
        });
        return;
      }

      if (!content || !content.trim()) return;

      const message = await prisma.message.create({
        data: {
          chatId,
          senderId: userId,
          content,
          messageType: 'text',
          status: 'sent',
        },
      });

      const payload = {
        id: message.id,
        chatId: message.chatId,
        senderId: message.senderId,
        content: message.content || '',
        timestamp: message.createdAt,
        type: 'text',
        status: 'delivered', // Message is delivered immediately to online recipients
        attachments: [],
      };

      io.to(`chat:${chatId}`).emit('new_message', { ...payload, tempId });
      socket.emit('message_saved', { tempId, message: payload });

      // Update message status to delivered in database
      await prisma.message.update({
        where: { id: message.id },
        data: { status: 'delivered' },
      });

      // Notify the recipient about unread message update
      const recipientId = chat.buyerId === userId ? chat.sellerId : chat.buyerId;
      const unreadCount = await prisma.message.count({
        where: {
          chatId: chatId,
          senderId: { not: recipientId }, // Messages NOT from the recipient (i.e., from the sender)
          status: { not: 'read' }, // Not read by the recipient
        },
      });

      io.to(`user:${recipientId}`).emit('unread_update', {
        chatId,
        unreadCount,
      });
    }
  );

  socket.on('disconnect', async () => {
    const state = onlineUsers.get(userId);
    if (!state) return;
    state.sockets.delete(socket.id);
    if (state.sockets.size === 0) {
      const lastSeenAt = new Date();
      onlineUsers.delete(userId);
      try {
        await prisma.seller.update({
          where: { id: userId },
          data: { lastSeenAt },
        });
      } catch (err) {
        console.error('Failed to update lastSeenAt', err);
      }

      // Notify relevant users that this user went offline (incremental update)
      const relevantUsers = await getRelevantUsers(userId);
      relevantUsers.forEach(relevantUserId => {
        io.to(`user:${relevantUserId}`).emit('user_offline', { userId, lastSeenAt });
      });

      console.log(`User ${userId} went offline, notified ${relevantUsers.length} relevant users`);
    } else {
      onlineUsers.set(userId, state);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Socket server listening on :${PORT}`);
});