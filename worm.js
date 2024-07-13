const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const _ = require('lodash');
const https = require('https');
const console = require('console');
const axios = require('axios')

const configFile = fs.readFileSync('config.json');
const configJson = JSON.parse(configFile);
const [host, user, password, database] = [configJson.mysql.host, configJson.mysql.user, configJson.mysql.password, configJson.mysql.database];
const [base, resourceBase, originUser] = [configJson.source.base, configJson.source.resourceBase, configJson.source.user];
const static = configJson.domain.static;

const db = mysql.createPool({
    host,
    user,
    password,
    database
});

https.globalAgent = new https.Agent({
    timeout: 60 * 1000,
    maxTotalSockets: 10
})

const URLs = {
    "StartLessonList": 'Vapp/Lesson/getStartLessonList',
    "EndLessonList": 'Vapp/Lesson/getEndLessonList',
    "EndLessonCmpflg": 'Vapp/Lesson/getEndLessonCmpflg',
    "PrereviewResource": 'Vapp/Prereview/getPrereviewResource',
    "EndLesson": 'Vapp/Lesson/getEndLesson',
    "ExamPart": 'Vapp/Challenge/getExamPart',
    "LessonBook": 'Vapp/Lesson/getLessonBook',
    "BookSource": 'Vapp/Book/getBookSource'
}

const resolveUrl = (url, base, queryString) => {
    if (queryString) {
        url = `${url}?${queryString}`;
    }
    try {
        return new URL(url)
    }
    catch (error) {
        return new URL(url, base)
    }
}

async function downloadPartUrl(source, base, maxRetries = 3) {
    const absoluteURL = resolveUrl(source, base)

    let retries = 0;
    let success = false;
    let relativePath = '';

    while (retries < maxRetries && !success) {
        try {
            const response = await axios.get(absoluteURL, { responseType: 'arraybuffer' });
            relativePath = absoluteURL.pathname
            if (relativePath.split('/').pop().search(/\./) == -1) {
                relativePath = `${relativePath}.mp4`
            }
            const outputPath = path.join("resourceDownloader", relativePath);

            // Ensure the directory exists
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });

            // Save the binary data to the local file system
            fs.writeFileSync(outputPath + '.temp', Buffer.from(response.data));
            console.log(`Downloaded and saved ${source} to ${outputPath}`);
            fs.rename(outputPath + '.temp', outputPath, (err) => { err && console.log(err) });
            success = true;
        } catch (error) {
            console.error(`Error downloading ${absoluteURL}: ${error.message}`);
            retries++;
            if (retries < maxRetries) {
                console.log(`Retrying (${retries}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, 1000 * retries));
            } else {
                console.error(`Max retries reached. Unable to download ${absoluteURL}`);
            }
        }
    }



    const url = resolveUrl(relativePath, `https://${static}/`);
    return url.toString()
}

const localizePartUrl = async (json) => {
    if (!json.partList) {
        return json
    }
    for (const part of json.partList) {
        if (part.url) {
            part.url = await downloadPartUrl(part.url);
        }
    }
    return json
}

async function updateColumn(table, mysqlValueJson) {
    for (const key of Object.keys(mysqlValueJson)) {
        try {
            if (typeof mysqlValueJson[key] == 'boolean') {
                await db.query(`alter table ${table} add \`${key}\` boolean`)
            }
            else if (typeof mysqlValueJson[key] == 'number') {
                await db.query(`alter table ${table} add \`${key}\` int`)
            }
            else if (typeof mysqlValueJson[key] == 'string' && mysqlValueJson[key].match(/^\d+$/)) {
                await db.query(`alter table ${table} add \`${key}\` int`)
            }
            else if (typeof mysqlValueJson[key] == 'string' && mysqlValueJson[key].length <= 255) {
                await db.query(`alter table ${table} add \`${key}\` varchar(255)`)
            }
            else {
                await db.query(`alter table ${table} add \`${key}\` text`)
            }
        } catch (error) {
            // console.log(3, error.sqlMessage)
        }
    }
}

async function modifyColumn(table, mysqlValueJson, column) {
    try {
        if (typeof mysqlValueJson[column] == 'boolean') {
            await db.query(`alter table ${table} modify\`${column}\` boolean`)
        }
        else if (typeof mysqlValueJson[column] == 'number') {
            await db.query(`alter table ${table} modify\`${column}\` int`)
        }
        else if (typeof mysqlValueJson[column] == 'string' && mysqlValueJson[column].match(/^\d+$/)) {
            await db.query(`alter table ${table} modify\`${column}\` int`)
        }
        else if (typeof mysqlValueJson[column] == 'string' && mysqlValueJson[column].length <= 255) {
            await db.query(`alter table ${table} modify\`${column}\` varchar(255)`)
        }
        else {
            await db.query(`alter table ${table} modify\`${column}\` text`)
        }
    } catch (error) {
        // console.log(3, error.sqlMessage)
    }
}

const TableNameReplacer = [
    {
        "PathNamePattern": '/',
        "replacement": "_"
    },
    {
        "PathNamePattern": "StartLessonList",
        "replacement": "EndLessonList"
    }
];
function pathNametoTableName(URLPathName = '/') {
    let table = URLPathName;
    for (const replacer of TableNameReplacer) {
        table = table.replaceAll(replacer.PathNamePattern, replacer.replacement);
    }

    table = table.toLowerCase();
    return table;
}

async function insertmysqlValueJson(table, valueJson, primaryKey) {
    const mysqlValueJson = Object.assign({}, valueJson);
    if (primaryKey) {
        mysqlValueJson.id = primaryKey;
    }

    for (const key of Object.keys(mysqlValueJson)) {
        if (typeof mysqlValueJson[key] == 'object' && mysqlValueJson[key] != null) {
            mysqlValueJson[key] = JSON.stringify(mysqlValueJson[key])
        }
    }

    try {
        await db.query('insert into ' + table + ' set ?', mysqlValueJson)
    } catch (error) {
        if (error.sqlMessage.search("Unknown") + 1) {
            await updateColumn(table, mysqlValueJson);
            await insertmysqlValueJson(table, mysqlValueJson);
            return
        }
        else if (error.sqlMessage.search("Duplicate") + 1) {
            return
        }
        else if (error.sqlMessage.search("Data too long") + 1) {
            const column = error.sqlMessage.match(/(')(.+?)(')/)[2];
            await modifyColumn(table, mysqlValueJson, column);
            await insertmysqlValueJson(table, mysqlValueJson);
            return
        }
        else if (error.sqlMessage.search("Data truncated") + 1) {
            const column = error.sqlMessage.match(/(')(.+?)(')/)[2];
            await modifyColumn(table, mysqlValueJson, column);
            await insertmysqlValueJson(table, mysqlValueJson);
            return
        }
        else {
            console.log(5, error.sqlMessage)
        }
    }
}

const PostHeaders = {
    Accept: "*/*",
    "Content-Type": "application/x-www-form-urlencoded",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
    Xweb_xhr: "1"
}
async function mysqlSingleResourceIndex(URLpathname, URLqueryJson, primaryKey, method = 'GET', valuePathofObject = '', FuncProcessValueJson) {
    const table = pathNametoTableName(URLpathname);
    try {
        await db.query('SELECT * FROM ' + table + ' limit 0')
    } catch (error) {
        await db.query('create table ' + table + ' (id int primary key)')
    }

    const URLQueryString = new URLSearchParams(URLqueryJson).toString();
    let resp;
    if (method == 'POST') {
        const full_url = resolveUrl(URLpathname, base)
        resp = await fetch(full_url, { method, body: URLQueryString, headers: PostHeaders })
    }
    else if (method == 'GET') {
        const full_url = resolveUrl(URLpathname, base, URLQueryString)
        resp = await fetch(full_url)
    }
    else {
        return
    }
    const respJson = await resp.json();

    let valueJson = {};
    if (valuePathofObject) {
        valueJson = _.get(respJson, valuePathofObject);
    } else {
        valueJson = respJson;
    }
    if (FuncProcessValueJson) {
        valueJson = await FuncProcessValueJson(valueJson);
    }

    await insertmysqlValueJson(table, valueJson, primaryKey);

    return valueJson
}

async function mysqldataResourceIndex(data, userid) {
    const URLQueryJson = {
        lessonid: data.lessonid,
        userid
    }
    await mysqlSingleResourceIndex(URLs.EndLesson, URLQueryJson, data.lessonid)

    for (const lessontype of [1, 2]) {
        const URLQueryJson = {
            classtype: data.classtype,
            classlevel: data.classlevel,
            lessontype,
            lessonno: data.lessonno,
            starttime: data.starttime,
            classid: data.classid,
            lessonid: data.lessonid,
            userid
        }
        let partList = await mysqlSingleResourceIndex(URLs.PrereviewResource, URLQueryJson, `${data.lessonid}00${lessontype}`, 'POST', 'data', localizePartUrl)
        partList = Array.isArray(partList) ? partList : Object.values(partList)

        for (const part of partList) {
            if (part.partid) {
                await mysqlSingleResourceIndex(URLs.ExamPart, { part_id: part.partid }, part.partid, 'POST', 'data')
            }
            if (part.bookid) {
                await mysqlSingleResourceIndex(URLs.BookSource, { bookid: part.bookid }, part.bookid, 'POST', 'data')
            }
        }
    }
    console.log(data.lessonid)
}

const LessonnameSearcher = [/G1B-4[4-9]/];
async function mysqldatalistIndex(URLPathName = '/', URLqueryJson) { //包含 insert 以及 BookSource 和 ExamPart
    const table = pathNametoTableName(URLPathName);
    try {
        await db.query('SELECT * FROM ' + table + ' limit 0')
    } catch (error) {
        await db.query('create table ' + table + ' (lessonid int primary key)')
    }

    const URLqueryString = new URLSearchParams(URLqueryJson).toString()
    const full_url = resolveUrl(URLPathName, base, URLqueryString)
    const resp = await fetch(full_url)
    const respJson = await resp.json()

    let dataArray = [];
    if (typeof respJson.datalist == 'object') {
        if (Array.isArray(respJson.datalist)) {
            dataArray = respJson.datalist;
        }
        else {
            try { dataArray = Object.values(respJson.datalist); } catch (err) { }
        }
    }

    for (const data of dataArray) {
        if (data.lock) {
            // console.log(1, `${data.lessonid} locked`);
            continue
        }

        let searchResult = false;
        for (const searcher of LessonnameSearcher) {
            if (data.lessonname.search(searcher) + 1) {
                searchResult = true;
                break
            }
        }
        if (!searchResult) {
            continue;
        }

        const [lessonid] = await db.query(`select lessonid from ${table} where lessonid = ?`, data.lessonid);
        if (!lessonid.length) {
            await mysqldataResourceIndex(data, URLqueryJson.userid);
            await insertmysqlValueJson(table, data);
        }


    }
    return dataArray
}


const worm = async () => {
    for (const user of originUser) {
        const [sessionid, userid] = [user.sessionId, user.userId];
        for (const url of [URLs.StartLessonList, URLs.EndLessonList]) {
            const dataArray = await mysqldatalistIndex(url, { sessionid, userid });
            const slug = url.split('/').pop();
            console.log(`userid: ${userid}, ${slug}: ${dataArray.length}`);
        }
    }
}

worm().then(() => {
    console.log('finished!')
    db.end()
})
