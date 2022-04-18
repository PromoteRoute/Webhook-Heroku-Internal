const app = require('express')();
const { uuid } = require('uuidv4');
const cors = require('cors');
const bodyParser = require('body-parser');
var validator = require('is-my-json-valid')
const server = require('http').createServer(app);
const io = require('socket.io')(server, { cors: { origin: '*' } });
const validateJson = require("./validate.json")
const jsonServer = require('json-server');
const fetch = require('cross-fetch');

server.listen(process.env.PORT || 3098);
app.use(cors({ exposedHeaders: ["Link"] }));
app.use(bodyParser.urlencoded({ extended: true, }));
app.use(bodyParser.json({ limit: "50MB" }));

const cors_proxy = require('cors-anywhere').createServer({
    originWhitelist: [],
    requireHeader: [],
    removeHeaders: []
})

io.on("connection", (socket) => {

    socket.on('join', function ({ roomId, url }) {
        (roomId || []).forEach(ele => socket.join(`${ele}`));
        retrivePendingWebhook({ roomId, url })
    });

    socket.on('retrive_webhook_queue', retrivePendingWebhook);

    socket.on('webhook_status_update', async function ({ data, url }) {
        let specificData = await getDataWebhookQueue({ url: `${url}/missed/webhook?socketId=${data.socketId}` });
        let index = specificData.findIndex(ele => ele.inner_ref_id === data.inner_ref_id)
        if (index >= 0 && specificData[index]) {
            await getDataWebhookQueue({ url: `${url}/missed/webhook/${specificData[index].id}`, method: "DELETE" })
            specificData.splice(index, 1)
            io.to(data.socketId).emit("webhook_queue", specificData)
        }
    });

    socket.on('disconnect', function () {
        socket.leave(`${socket.id}`)
    });

    async function retrivePendingWebhook({ roomId, url }) {
        let allPendingQueue = [];
        for (let i = 0; i < (roomId || []).length; i++) {
            let res = await getDataWebhookQueue({ url: `${url}/missed/webhook?socketId=${roomId[i]}` });
            allPendingQueue = allPendingQueue.concat(res || [])
        }
        io.to(socket.id).emit("webhook_queue", allPendingQueue)
    }
});

function sendDataToSocekt(req, isValid, response, status) {
    let socketId = `${req.params.mo_no}$$$${req.params.unique_id}`;
    let sendData = { socketId, error: !isValid, from: atob(req.params.mo_no), uniqueId: req.params.unique_id, url: req.protocol + "://" + req.get('host') + req.originalUrl, request: req.body, response, status, inner_ref_id: uuid() }
    try {
        let roomIds = Array.from(io.sockets?.adapter?.rooms || [])
        let userRoomId = roomIds.filter(room => !room[1].has(room[0])).find(ele => ele[0] === socketId)
        if (!!userRoomId) {
            let roomSocketIds = Array.from(userRoomId[1])
            if (roomSocketIds.length > 0) {
                io.to(roomSocketIds[0]).emit("pr_webhook_received", sendData)
            } else {
                addDataInwebhookQueue(req, sendData)
            }
        } else {
            addDataInwebhookQueue(req, sendData)
        }
    } catch (error) {
        addDataInwebhookQueue(req, sendData)
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

app.use('/missed', jsonServer.router('db.json'));

app.get('/proxy/:proxyUrl*', (req, res) => {
    req.url = req.url.replace('/proxy/', '/');
    cors_proxy.emit('request', req, res);
});

app.use('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

function addDataInwebhookQueue(req, sendData) {
    let url = req.protocol + "://" + req.get('host') + "/missed/webhook"
    fetch(url, { method: 'POST', body: JSON.stringify(sendData), headers: { 'Content-Type': 'application/json' } })
}

function getDataWebhookQueue({ url, method = "GET", callback = () => { } }) {
    return new Promise((resolve) => {
        fetch(url.replace(/([^:]\/)\/+/g, "$1"), { method }).then(r => r.json()).then(res => {
            callback(res)
            resolve(res)
        })
    })
}