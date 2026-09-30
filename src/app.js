const express = require("express");

const app = express();

app.use(express.json());

app.get('/', async(req, res) => {
    console.log("Hello World!");
    res.json({
        success: true, 
        message: "서버 연결 성공"
    });
});

module.exports = app;