const app = require('express')();
const { uuid } = require('uuidv4');
const cors = require('cors');
const bodyParser = require('body-parser');
var validator = require('is-my-json-valid')
const server = require('http').createServer(app);
const io = require('socket.io')(server, { cors: { origin: '*' } });
const validateJson = require("./validate.json")
const { Pool } = require('postgres-pool')

server.listen(process.env.PORT || 3098);
app.use(cors({ exposedHeaders: ["Link"] }));
app.use(bodyParser.urlencoded({ extended: true, }));
app.use(bodyParser.json({ limit: "50MB" }));

var pool = null

if (!!process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    createTable()
}

const cors_proxy = require('cors-anywhere').createServer({
    originWhitelist: [],
    requireHeader: [],
    removeHeaders: []
})

io.on("connection", (socket) => {

    socket.on('join', function (roomId) {
        (roomId || []).forEach(ele => socket.join(`${ele}`));
        retrivePendingWebhook(roomId)
    });

    socket.on('retrive_webhook_queue', retrivePendingWebhook);

    socket.on('webhook_status_update', async function (data) {
        let specificAllData = await getMissedWebhookBySocekt(data.socketId);
        let specificData = (specificAllData || []).map(ele => ele.mw_data)
        let index = specificData.findIndex(ele => ele.inner_ref_id === data.inner_ref_id)
        if (index >= 0 && specificData[index]) {
            await deleteMissedWebhookBySocekt(specificAllData[index].mw_id)
            specificData.splice(index, 1)
            io.to(data.socketId).emit("webhook_queue", specificData)
        }
    });

    socket.on('disconnect', function () {
        socket.leave(`${socket.id}`)
    });

    async function retrivePendingWebhook(roomId) {
        let allPendingQueue = [];
        for (let i = 0; i < (roomId || []).length; i++) {
            let res = await getMissedWebhookBySocekt(roomId[i]);
            res = (res || []).map(ele => ele.mw_data)
            allPendingQueue = allPendingQueue.concat(res)
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
                addDataInWebhookQueue(sendData)
            }
        } else {
            addDataInWebhookQueue(sendData)
        }
    } catch (error) {
        addDataInWebhookQueue(sendData)
    }
}

async function checkHeader(req, res, next) {
    let apiKey = req.headers && (req.headers['X-PR-API-KEY'] || req.headers['x-pr-api-key'])
    if (!apiKey) {
        res.status(401);
        res.json({ status: 401, error: 'Access token is missing' });
        return
    }

    let response = await checkIsKeyAdded(apiKey);
    if (response && response.length > 0) {
        next()
    } else {
        res.status(401);
        res.json({ status: 401, error: 'Access token is invalid' });
    }
}

app.post('/api/v1/pr-webhook/:mo_no/:unique_id', checkHeader, (req, res) => {
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

app.post('/api/v1/pr-apikey/add', async (req, res) => {
    try {
        let getKeyData = await executeQuery(`select * from public.api_key where ak_key = $1`, [req.body.key])
        if (!!getKeyData && getKeyData.rows && getKeyData.rows.length > 0) {
            res.status(200);
            res.json({ status: 200 });
            return
        }

        let results = await executeQuery(`insert into public.api_key (ak_key) values ($1)`, [req.body.key])
        if (!!results) {
            res.status(200);
            res.json({ status: 200 });
        } else {
            res.status(400);
            res.json({ status: 400 });
        }
    } catch (error) {
        res.status(500);
        res.json({ status: 500, error: 'Something went wrong. try again after some time.' });
    }
});

app.delete('/api/v1/pr-apikey/:key', async (req, res) => {
    try {
        let results = await executeQuery(`delete from public.api_key where ak_key = $1`, [req.params.key])
        if (!!results) {
            res.status(200);
            res.json({ status: 200 });
        } else {
            res.status(400);
            res.json({ status: 400 });
        }
    } catch (error) {
        res.status(500);
        res.json({ status: 500, error: 'Something went wrong. try again after some time.' });
    }
});

app.get('/proxy/:proxyUrl*', (req, res) => {
    req.url = req.url.replace('/proxy/', '/');
    cors_proxy.emit('request', req, res);
});

app.use('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

async function createTable() {
    executeQuery('CREATE TABLE IF NOT EXISTS public.missed_webhook (mw_id bigserial, mw_data json, mw_socket_id text, mw_config json, mw_created_at timestamp with time zone DEFAULT now()); CREATE TABLE IF NOT EXISTS public.api_key (ak_id bigserial, ak_key text, ak_created_at timestamp with time zone DEFAULT now());');
}

function addDataInWebhookQueue(sendData) {
    executeQuery('insert into public.missed_webhook (mw_data, mw_socket_id) values ($1, $2)', [JSON.stringify(sendData), sendData.socketId]);
}

function getMissedWebhookBySocekt(roomId) {
    return new Promise(async (resolve) => {
        let results = await executeQuery(`select * from public.missed_webhook where mw_socket_id = $1`, [roomId]);
        resolve(results?.rows)
    })
}

function checkIsKeyAdded(key) {
    return new Promise(async (resolve) => {
        let results = await executeQuery(`select * from public.api_key where ak_key = $1`, [key]);
        resolve(results?.rows)
    })
}

function deleteMissedWebhookBySocekt(id) {
    return new Promise(async (resolve) => {
        await executeQuery(`delete from public.missed_webhook where mw_id = $1`, [id]);
        resolve(true)
    })
}

function executeQuery(query, value = []) {
    return new Promise(async (resolve) => {
        if (!!pool) {
            let results = await pool.query(query, value);
            resolve(results)
        } else {
            resolve(null)
        }
    })
}