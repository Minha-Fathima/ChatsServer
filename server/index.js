  // server/index.js
  const express = require('express');
  const http = require('http');
  const socketIO = require('socket.io');
  const cors = require('cors');
  const mysql = require('mysql');
  const dotenv = require('dotenv');
  const fs = require('fs');
  const path = require('path'); 
  const multer = require('multer');
  const axios = require('axios');
  const FormData = require('form-data');
  //to store user-socket mapping
  const userSocketMap = {};
  // Specify the path to the .env file
  const envPath = path.join(__dirname, '..', '.env'); // Assumes .env is in chat-app directory
  dotenv.config({ path: envPath }); // Load the .env file



  //----------------AZURE DATABASE CONNECTION------------------//
  const connection = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
    ssl: {
      ca: fs.readFileSync(process.env.DB_SSL_CA_PATH),
    },
  });
  
//----------------LOCAL DATABASE CONNECTION------------------//
// const connection = mysql.createConnection({
//   host: "localhost",
//   user: "root",
//   password: "@123Abcd",
//   database: "chat",
//   port: "3306"
});
//----------------------------------------------------------//

connection.connect((err) => {
  if (err) {
    console.error('Error connecting to Azure MySQL Database:', err.stack);
    return;
  }
  console.log('Connected to Azure MySQL Database!');
});


  //function to execute mysql query asynchronously
  const queryAsync = (sql, values) => {
    return new Promise((resolve, reject) => {
      connection.query(sql, values, (error, results) => {
        if (error) {
          return reject(error);
        }
        resolve(results);
      });
    });
  }; 


  //function to insert message into database
  const insertMessage = async (workspaceId, senderId, receiverId, message, messageType) => {
    try {
      const query = `
        INSERT INTO Messages (WsId, SenderId, ReceiverId, Message, MessageType)
        VALUES (?, ?, ?, ?, ?)
      `;
      const values = [workspaceId, senderId, receiverId, message, messageType];
      await queryAsync(query, values);
      console.log('Message successfully inserted into the database:', { workspaceId, senderId, receiverId, message, messageType });
      return true;
    } catch (error) {
      console.error('Error inserting message into the database:', error);
      return false;
    }
  };




  //------------------SERVER CONNECTION------------------//
  const app = express();
  const corsOptions = {
      origin: 'http://localhost:3000', 
      methods: ['GET', 'POST'],
    };
    app.use(cors(corsOptions));
    app.use('/socket.io', express.static('node_modules/socket.io/client-dist'));
  
  const server = http.createServer(app);
  const io = socketIO(server, {
      cors: corsOptions, 
    });

  const PORT = process.env.PORT || 3001;

  //------------------FETCHING DATA FROM DATABASE------------------//
  // app.get('/workspace-members', async (req, res) => {
  //   const { workspaceId } = req.query;

  //   try {
  //     //'SELECT UserId, UserName FROM Members WHERE WorkspaceId = ?' --> to get username as well
  //     const membersQuery = 'SELECT UserId FROM Members WHERE WorkspaceId = ?';
  //     const members = await queryAsync(membersQuery, [workspaceId]);
  //     res.json(members);
  //   } catch (error) {
  //     console.error('Error fetching workspace members:', error);
  //     res.status(500).json({ error: 'Internal Server Error' });
  //   }
  // });


  app.get('/public-messages', async (req, res) => {
    const { workspaceId } = req.query;

    try {
      const publicMessagesQuery = 'SELECT SenderId, message, Timestamp, MessageType FROM Messages WHERE WsId = ? AND ReceiverId = "workspace"';
      const publicMessages = await queryAsync(publicMessagesQuery, [workspaceId]);

      res.json(publicMessages);
    } catch (error) {
      console.error('Error fetching public messages:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.get('/private-messages', async (req, res) => {
    const { userId1, userId2, workspaceId } = req.query;

    try {
      const privateMessagesQuery = `
        SELECT SenderId, ReceiverId, message, Timestamp, MessageType 
        FROM Messages 
        WHERE WsId = ? AND (
          (SenderId = ? AND ReceiverId = ?) OR (SenderId = ? AND ReceiverId = ?)
        ) ORDER BY Timestamp`;

      const privateMessages = await queryAsync(privateMessagesQuery, [workspaceId, userId1, userId2, userId2, userId1]);
      res.json(privateMessages);
    } catch (error) {
      console.error('Error fetching private messages:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  //------------------MULTER FILE UPLOAD------------------//
  const uploadsDir = path.join(__dirname, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true }); // Ensure uploads directory exists
  
  const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, uploadsDir); // Destination folder
    },
    filename: function (req, file, cb) {
      cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname)); // Filename format
    }
  });
  
  const upload = multer({ storage: storage });
  
  app.post('/uploads', upload.single('myfile'), async (req, res) => {
    if (!req.file) {
      return res.status(400).send('No file uploaded.');
    }
    const fileUrl = `http://localhost:3001/uploads/${req.file.filename}`;
    res.json({ message: 'File uploaded successfully.', url: fileUrl });
  });
  
  app.use('/uploads', express.static(uploadsDir));


  //------------------SOCKET CONNECTION------------------//
  io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId; // Extract userId from query params
    userSocketMap[userId] = socket.id;
    console.log(`user connected with Id: ${userId} and socket id: ${socket.id}`)


  //--------------- Handling chat events-----------------//
    
  socket.on('public-message', async (data) => {
    if (data.MessageType && data.MessageType !== 'text') {
      await handleFileMessage(data, 'file-message');
    } else {
      await handleTextMessage(data, 'public-message');
    }
  });
  
  socket.on('private-message', async (data) => {
    if (data.MessageType && data.MessageType !== 'text') {
      await handleFileMessage(data, 'file-message');
    } else {
      await handleTextMessage(data, 'private-message');
    }
  });
   
    //----------------------------------------------//

    socket.emit('user-connected', userId);
    
    socket.on('disconnect', () => {
      console.log(`User disconnected with ID: ${userId}`);
      delete userSocketMap[userId];
    });
  });

  //------------------HANDLING NEW MESSAGE------------------//
async function handleTextMessage(data, type) {
  // Extract necessary information from the data object
  const { workspaceId, senderId ,receiverId, message } = data;

  // Perform a check to ensure all necessary data is present
  if (!workspaceId || !senderId || !receiverId || !message) {
      console.error('Missing data for text message:', data);
      return; // Exit the function if data is missing
  }

  // Call Sightengine API to check the message
  try {
    const form = new FormData();
    form.append('text', message);
    form.append('lang', 'en'); 
    form.append('mode', 'rules');
    form.append('api_user', process.env.APIUSER);
    form.append('api_secret', process.env.APISECRET);

    const response = await axios({
      url: 'https://api.sightengine.com/1.0/text/check.json',
      method: 'post',
      data: form,
      headers: form.getHeaders()
    });

      let isMessageFlagged = false;

      // Check if any profanity is detected
      if (response.data.profanity && response.data.profanity.matches && response.data.profanity.matches.length > 0) {
        isMessageFlagged = true;
      }

      // Check if any personal information is detected
      if (response.data.personal && response.data.personal.matches && response.data.personal.matches.length > 0) {
        isMessageFlagged = true;
      }

      // Check if any links are detected
      if (response.data.link && response.data.link.matches && response.data.link.matches.length > 0) {
        isMessageFlagged = true;
      }

      const finalMessage = isMessageFlagged 
        ? 'This message was flagged as inappropriate' 
        : message;

      // Broadcast the message (either original or replaced)
      io.emit(type, { sender: senderId, message: finalMessage, Timestamp: new Date() });

      await insertMessage(workspaceId, senderId, receiverId, finalMessage, 'text');

  } catch (error) {
    console.error('Error with Sightengine API:', error);
  }

}

async function handleFileMessage(data, type) {
  const { workspaceId, senderId, receiverId, message, MessageType } = data;

  if (!workspaceId || !senderId || !receiverId || !message || !MessageType) {
    console.error('Missing data for file message:', data);
    return;
  }

  const filename = message.split('/').pop();
  const filePath = path.join(uploadsDir, filename);
  const isImage = MessageType.startsWith('image/');
  const isVideo = MessageType.startsWith('video/');

  try {
    const formData = new FormData();
    formData.append('media', fs.createReadStream(filePath));
    formData.append('models', 'nudity,wad,offensive,gore');
    formData.append('api_user', '1032749883');
    formData.append('api_secret', '6cWqqCnVH3QBxNfB2ePLMEeDGSXpi7wU');

    const apiEndpoint = isImage ? 'https://api.sightengine.com/1.0/check.json' 
                                : 'https://api.sightengine.com/1.0/video/check.json';

    const response = await axios({
      method: 'post',
      url: apiEndpoint,
      data: formData,
      headers: formData.getHeaders()
    });


    let finalMessage = message;
    let finalMessageType = MessageType;
    let isContentFlagged = false;
    let broadMessageType;
  if (MessageType.startsWith('image/')) {
    broadMessageType = 'image';
  } else if (MessageType.startsWith('video/')) {
    broadMessageType = 'video';
  } else if (MessageType.startsWith('audio/')) {
    broadMessageType = 'audio';
  } else {
    // Default to text if unable to categorize
    broadMessageType = 'text';
  }




    // Check Sightengine API response
    if ((response.data.nudity && (
      response.data.nudity.sexual_activity > 0.5 ||
      response.data.nudity.sexual_display > 0.5 ||
      response.data.nudity.erotica > 0.5 ||
      response.data.nudity.sextoy > 0.5 ||
      response.data.nudity.suggestive > 0.5
    )) ||
    (response.data.weapon && response.data.weapon > 0.5) ||
    (response.data.alcohol && response.data.alcohol > 0.5) ||
    (response.data.drugs && response.data.drugs > 0.5) ||
    (response.data.offensive && response.data.offensive.prob > 0.5) ||
    (response.data.gore && response.data.gore.prob > 0.5)) {
    isContentFlagged = true;
    }


    if (isContentFlagged) {
      // Content is inappropriate - change message
      if (isImage) {
        finalMessage = 'This image was flagged as inappropriate';
      } else if (isVideo) {
        finalMessage = 'This video was flagged as inappropriate';
      }
      finalMessageType = 'text'; // Change message type as it's no longer a file
      broadMessageType = 'text'; 
    }
    
    console.log("Emitting message with URL:", finalMessage);
    // Insert the message into the database

    await insertMessage(workspaceId, senderId, receiverId, finalMessage, broadMessageType);

    // Emit the message
    io.emit(type, {sender: senderId, receiverId, message: finalMessage, Timestamp: new Date(), MessageType: finalMessageType });

  } catch (error) {
    console.error('Error with Sightengine API:', error);
  }
}



// async function handleFileMessage(data, type) {
//   const { workspaceId, senderId, receiverId, message, MessageType } = data;

//   if (!workspaceId || !senderId || !receiverId || !message || !MessageType) {
//       console.error('Missing data for file message:', data);
//       return; // Exit the function if data is missing
//   }

//   await insertMessage(workspaceId, senderId, receiverId, message, MessageType);
//   io.emit(type, {sender: senderId, receiverId, message, Timestamp: new Date(), MessageType });
// }


  //------------------STARTING SERVER------------------//
  server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });



  
