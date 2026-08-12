
const { createClient } = require('redis');



const QUEUE_NAME = process.env.QUEUE_NAME || 'ticket_orders';



const redisClient = createClient({

  socket: {

    host: process.env.REDIS_HOST || 'redis',

    port: parseInt(process.env.REDIS_PORT || '6379', 10),

  },

});



redisClient.on('error', (err) => {

  console.error('[redis] client error', err.message);

});



async function connectRedis() {

  if (!redisClient.isOpen) {

    await redisClient.connect();

  }

}



async function pushOrder(order) {

  await connectRedis();

  await redisClient.lPush(QUEUE_NAME, JSON.stringify(order));

}



async function pingRedis() {

  await connectRedis();

  await redisClient.ping();

}



module.exports = { redisClient, connectRedis, pushOrder, pingRedis, QUEUE_NAME };

