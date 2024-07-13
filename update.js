const fs = require('fs');
const mysql = require('mysql2/promise');

const table = 'vapp_prereview_getprereviewresource'


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
    try { await db.query(`create table _${table} select * from ${table}`) } catch (error) { }
    await db.query(`alter table ${table} add primary key(id);`).catch((err) => {
        console.log(err.sqlMessage)
    })

    const [json] = await db.query(`select * from ${table}`)
    for (const item of json) {
        console.log(item.id)
        const data = JSON.parse(item.data || '{}')
        for (const key of Object.keys(data)) {
            const exists = await db.query(`SELECT * FROM information_schema.columns where table_name='${table}' and column_name='${key}'`)
            if (!exists[0].length) {
                if (typeof data[key] == 'number') {
                    await db.query(`alter table ${table} add \`${key}\` int`)
                }
                else if (typeof data[key] == 'string') {
                    await db.query(`alter table ${table} add \`${key}\` text`)
                }
                else {
                    await db.query(`alter table ${table} add \`${key}\` text`)
                }
            }
            if (typeof data[key] != 'number' && typeof data[key] != 'string' && data[key] != null) {
                data[key] = JSON.stringify(data[key])
            }
            else if (typeof data[key] == 'string') {
                data[key] = data[key]
            }
            item[key] = data[key]

        }
        delete item.data, item.code, item.error
        await db.query(`replace into ${table} set ?`, item).catch((err) => {
            console.log(err.sqlMessage)
            // console.log(err)
            // throw err
        })
    }

    const dropColumn = []
    for (const column of dropColumn) {
        await db.query(`alter table ${table} drop column ${column};`).catch((err) => {
            console.log(err.sqlMessage)
        })
    }

    db.end()
})()

