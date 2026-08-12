
const express = require('express');

const cors = require('cors');

const { v4: uuidv4 } = require('uuid');

const { pool, initSchema, checkConnection } = require('./db');

const { pushOrder, pingRedis } = require('./queue');

const { EVENTS, isValidEvent } = require('./events');



const app = express();

const PORT = parseInt(process.env.API_PORT || '8080', 10);



app.use(cors());

app.use(express.json());



app.get('/healthz', (req, res) => {

  res.status(200).json({ status: 'ok', service: 'api' });

});



app.get('/readyz', async (req, res) => {

  try {

    await checkConnection();

    await pingRedis();

    res.status(200).json({ status: 'ready', service: 'api' });

  } catch (err) {

    console.error('[readyz] dependency check failed:', err.message);

    res.status(503).json({ status: 'not_ready', service: 'api', error: err.message });

  }

});



app.get('/events', (req, res) => {

  res.status(200).json(EVENTS);

});



app.post('/tickets/purchase', async (req, res) => {

  const { eventId, customerEmail, quantity } = req.body || {};



  if (!eventId || !customerEmail || !quantity) {

    return res.status(400).json({ error: 'eventId, customerEmail and quantity are required' });

  }

  if (!isValidEvent(eventId)) {

    return res.status(404).json({ error: `Unknown eventId: ${eventId}` });

  }

  const qty = Number(quantity);

  if (!Number.isInteger(qty) || qty <= 0) {

    return res.status(400).json({ error: 'quantity must be a positive integer' });

  }



  const orderId = uuidv4();

  const order = {

    orderId,

    eventId,

    customerEmail,

    quantity: qty,

    status: 'queued',

  };



  try {

    await pool.query(

      `INSERT INTO orders (order_id, event_id, customer_email, quantity, status)

       VALUES ($1, $2, $3, $4, 'queued')`,

      [orderId, eventId, customerEmail, qty],

    );

    await pushOrder(order);

    res.status(202).json({ message: 'Order queued', orderId });

  } catch (err) {

    console.error('[purchase] failed:', err.message);

    res.status(500).json({ error: 'Failed to queue order' });

  }

});



app.get('/tickets/orders', async (req, res) => {

  try {

    const result = await pool.query(

      `SELECT order_id, event_id, customer_email, quantity, status, created_at

       FROM orders ORDER BY created_at DESC LIMIT 200`,

    );

    res.status(200).json(result.rows);

  } catch (err) {

    console.error('[orders] failed:', err.message);

    res.status(500).json({ error: 'Failed to fetch orders' });

  }

});



app.use((req, res) => {

  res.status(404).json({ error: 'Not found' });

});



async function start() {

  let retries = 10;

  while (retries > 0) {

    try {

      await initSchema();

      break;

    } catch (err) {

      retries -= 1;

      console.error(`[startup] DB not ready yet (${err.message}), retries left: ${retries}`);

      await new Promise((r) => setTimeout(r, 3000));

    }

  }

  app.listen(PORT, () => {

    console.log(`[api] listening on port ${PORT}`);

  });

}



start();

