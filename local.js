const fs = require('fs');
const mysql = require('mysql2/promise');

const configFile = fs.readFileSync('config.json');
const configJson = JSON.parse(configFile);
const [host, user, password, database] = [configJson.mysql.host, configJson.mysql.user, configJson.mysql.password, configJson.mysql.database];

const db = mysql.createPool({
    host,
    user,
    password,
    database
});
(async function () {
    const [json] = await db.query('SELECT * FROM vapp_lesson_getendlessonlist left join vapp_prereview_getprereviewresource on lessonid=cast(id/10 as unsigned) where lessonname like "k3%" order by lessonno+0 desc;')
    const stream = fs.createWriteStream('video_K3_series.txt', 'utf-8')

    for (const item of json) {
        // stream.write('\n' + item.lessonname)
        let partList = [];
        try { partList = JSON.parse(item.partList); } catch (error) { }
        for (const part of partList) {
            try {
                stream.write(part.url ? '\n' + part.url : '')
                console.log(part.url)

                const part = partList[1]
                stream.write(part.url ? '\n' + part.url : '')
            } catch (error) { }
        }
    }

    db.end()
})();
