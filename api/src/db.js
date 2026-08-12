
const { Pool } = require('pg');



const pool = new Pool({

  host: process.env.POSTGRES_HOST || 'postgres',

  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),

  database: process.env.POSTGRES_DB || 'ticketing',

  user: process.env.POSTGRES_USER || 'ticketing_user',

  password: process.env.POSTGRES_PASSWORD,

  max: 10,

  idleTimeoutMillis: 30000,

  connectionTimeoutMillis: 5000,

});



async function initSchema() {

  await pool.query(`

    CREATE TABLE IF NOT EXISTS orders (

      order_id UUID PRIMARY KEY,

      event_id TEXT NOT NULL,

      customer_email TEXT NOT NULL,

      quantity INTEGER NOT NULL CHECK (quantity > 0),

      status TEXT NOT NULL DEFAULT 'queued',

      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()

    );

  `);

}



async function checkConnection() {

  await pool.query('SELECT 1');

}



module.exports = { pool, initSchema, checkConnection };

