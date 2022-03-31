const app = require('express')();
const { uuid } = require('uuidv4');
const cors = require('cors');
const bodyParser = require('body-parser');
const server = require('http').createServer(app);
const io = require('socket.io')(server, { cors: { origin: '*' } });

server.listen(process.env.PORT || 3098);
app.use(cors({ exposedHeaders: ["Link"] }));
app.use(bodyParser.urlencoded({ extended: true, }));
app.use(bodyParser.json({ limit: "50MB" }));

let webhookQueue = {}

io.on("connection", (socket) => {

    socket.on('join', function (data) {
        (data || []).forEach(ele => socket.join(`${ele}`));
        retrivePendingWebhook(data)
    });

    socket.on('retrive_webhook_queue', retrivePendingWebhook);

    socket.on('webhook_status_update', function (data) {
        let socketId = data.room_id, specificData = webhookQueue[socketId] || []
        let index = specificData.findIndex(ele => ele.inner_ref_id = data.data.inner_ref_id)
        if (index >= 0) {
            specificData.splice(index, 1)
            webhookQueue[socketId] = specificData
            io.to(socketId).emit("webhook_queue", specificData)
        }
    });

    socket.on('disconnect', function () {
        socket.leave(`${socket.id}`)
    });

    function retrivePendingWebhook(data) {
        let allPendingQueue = [];
        (data || []).forEach(ele => allPendingQueue = allPendingQueue.concat(webhookQueue[ele] || []));
        io.to(socket.id).emit("webhook_queue", allPendingQueue)
    }
});

app.post('/api/v1/pr-webhook/:mo_no/:unique_id', (req, res) => {
    let socketId = `${atob(req.params.mo_no)}$$$${req.params.unique_id}`
    try {
        let roomIds = Array.from(io.sockets?.adapter?.rooms || [])
        let userRoomId = roomIds.filter(room => !room[1].has(room[0])).find(ele => ele[0] === socketId)
        if (!!userRoomId) {
            let roomSocketIds = Array.from(userRoomId[1])
            if (roomSocketIds.length > 0) {
                io.to(roomSocketIds[0]).emit("pr_webhook_received", req.body)
            } else {
                addDataInwebhookQueue(socketId, req)
            }
        } else {
            addDataInwebhookQueue(socketId, req)
        }
    } catch (error) {
        addDataInwebhookQueue(socketId, req)
    }

    res.status(200);
    res.json({ status: 200 });
});

app.use('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

function addDataInwebhookQueue(socketId, req) {
    webhookQueue[socketId] = webhookQueue[socketId] || []
    webhookQueue[socketId].push({ ...req.body, socketId, inner_ref_id: uuid() })
}