const fs = require('fs');
const mysql = require('mysql2/promise');
const path = require('path');

const configFile = fs.readFileSync('config.json');
const configJson = JSON.parse(configFile);
const [host, user, password, database] = [configJson.mysql.host, configJson.mysql.user, configJson.mysql.password, configJson.mysql.database];

const db = mysql.createPool({
    host,
    user,
    password,
    database
});

const ls = fs.readdirSync(path.resolve('resourceDownloader'));

(async function () {
    for (const file of ls) {
        const name = `%${file}%`
        const [json] = await db.query('SELECT * FROM vapp_prereview_getprereviewresource where partList like ?;', name)
        if (!json.length) {
            console.log('no ' + file)
        }
        else {
            const partList = JSON.parse(json[0].partList)
            for (const part of partList) {
                if (part.title.match(/拓展视频|动漫歌曲|动漫故事|故事预热/)) {
                    console.log(part.title, part.url)
                }
            }
        }
    }
    db.end();
})()