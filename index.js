const app = require('express')();
const { uuid } = require('uuidv4');
const cors = require('cors');
const bodyParser = require('body-parser');
var validator = require('is-my-json-valid')
const server = require('http').createServer(app);
const io = require('socket.io')(server, { cors: { origin: '*' } });
const validateJson = require("./validate.json")

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
        let specificData = webhookQueue[data.socketId] || []
        let index = specificData.findIndex(ele => ele.inner_ref_id = data.inner_ref_id)
        if (index >= 0) {
            specificData.splice(index, 1)
            webhookQueue[data.socketId] = specificData
            io.to(data.socketId).emit("webhook_queue", specificData)
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

function sendDataToSocekt(req, isValid, response, status) {
    let socketId = `${req.params.mo_no}$$$${req.params.unique_id}`;
    let sendData = { socketId, error: !isValid, from: atob(req.params.mo_no), uniqueId: req.params.unique_id, url: req.url, request: req.body, response, status, inner_ref_id: uuid() }
    try {
        let roomIds = Array.from(io.sockets?.adapter?.rooms || [])
        let userRoomId = roomIds.filter(room => !room[1].has(room[0])).find(ele => ele[0] === socketId)
        if (!!userRoomId) {
            let roomSocketIds = Array.from(userRoomId[1])
            if (roomSocketIds.length > 0) {
                io.to(roomSocketIds[0]).emit("pr_webhook_received", sendData)
            } else {
                addDataInwebhookQueue(socketId, sendData)
            }
        } else {
            addDataInwebhookQueue(socketId, sendData)
        }
    } catch (error) {
        addDataInwebhookQueue(socketId, sendData)
    }
}

app.post('/api/v1/pr-webhook/:mo_no/:unique_id', (req, res) => {
    try {
        var validate = validator(validateJson)
        let isValid = validate(req.body, { greedy: true });
        let status = isValid ? 200 : 422
        let successJson = { status, error: validate.errors }
        sendDataToSocekt(req, isValid, successJson, status)
        res.status(status);
        res.json(successJson);
    } catch (error) {
        let errJson = { status: 500, error: error.message }
        sendDataToSocekt(req, false, errJson, 500)
        res.status(500);
        res.json(errJson);
    }
});

app.get('/api/v1/pr-webhook/test', (req, res) => {
    res.status(200);
    res.json({ status: 200 });
});

app.use('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

function addDataInwebhookQueue(socketId, sendData) {
    webhookQueue[socketId] = webhookQueue[socketId] || []
    webhookQueue[socketId].push(sendData)
}