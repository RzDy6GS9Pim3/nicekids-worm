const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const _ = require('lodash');
const https = require('https');
const axios = require('axios')
const config = require('./config.json');
const URLs = require("./url.json");

// 是否将新数据插入数据库
const INSERT = false;
// 是否增加资源可读性 而不使用来源的路径
const READABLE = true;
// 是否强制更新 不查重
const FORCE = true;

const [HOST, PORT, USER, PASSWORD, DATABASE] = [config.mysql.host, config.mysql.port, config.mysql.user, config.mysql.password, config.mysql.database];
const [BASE, resourceBase, ORIGIN_USER] = [config.source.base, config.source.resourceBase, config.source.user];
const STATIC_URL = config.domain.static;

const db = mysql.createPool({
    host: HOST,
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: DATABASE
});

https.globalAgent = new https.Agent({
    timeout: 60 * 1000,
    maxTotalSockets: 10
})


// 返回完整url
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

async function downloadUrl(source, base, relativePath, ext, maxRetries = 3) {
    const absoluteURL = resolveUrl(source, base)

    let retries = 0;
    let success = false;

    while (retries < maxRetries && !success) {
        try {
            const response = await axios.get(absoluteURL, { responseType: 'arraybuffer' });
            // 配置相对路径和拓展名
            if (!relativePath) {
                relativePath = absoluteURL.pathname
            }
            if (typeof ext === 'string' && relativePath.split('/').pop().search(/\./) === -1) {
                relativePath = `${relativePath}.${ext}`
            }
            const outputPath = path.join("resourceDownloader", LessonnameSearcher.toString().match(/[a-zA-Z\d]+/).pop(), relativePath);
            // Ensure the directory exists
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });

            // 写入时保存到临时文件 写完改名
            fs.writeFileSync(outputPath + '.temp', Buffer.from(response.data));
            console.log(`Downloaded and saved ${source} to ${outputPath}`);
            fs.rename(outputPath + '.temp', outputPath, (err) => { err && console.log(err) });
            success = true;
        } catch (error) {
            console.error(`Error downloading ${absoluteURL}: ${error.message}`);
            retries++;
            if (retries < maxRetries && error.message.search(/4\d\d/) === -1) {
                console.log(`Retrying (${retries}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, 1000 * retries));
            } else {
                console.error(`Max retries reached. Unable to download ${absoluteURL}`);
            }
        }
    }

    return relativePath
}


// 下载partlist中的url 并返回修改过的prereviewResource 因为要传递lessonname 所以使用闭包
function localizePartUrlClosure(lessonname, tabBarName) {
    // 下载partlist中的url 并返回修改过的prereviewResource
    const localizePartUrl = async (prereviewResource) => {
        if (!prereviewResource.partList) {
            return prereviewResource
        }
        for (const part of prereviewResource.partList) {
            const { url, title } = part;
            if (url) {
                let relativePath = '';
                if (READABLE === true) {
                    const pathname = `${lessonname.split('-').slice(0, 2).join('-')}/${tabBarName}/${title}/${url.split('/').slice(-1).pop()}`;
                    relativePath = await downloadUrl(url, undefined, pathname, 'mp4');
                } else {
                    relativePath = await downloadUrl(url);
                }
                part.url = resolveUrl(relativePath, `https://${STATIC_URL}/`).toString();
            }
        }
        return prereviewResource
    }

    return localizePartUrl
}


// 下载data中的lessoncover 并返回修改过的data
const localizeLessoncoverUrl = async (data) => {
    const { lessonname, lessoncover } = data;
    let relativePath = '';
    if (READABLE === true) {
        const pathname = `${lessonname.split('-').slice(0, 2).join('-')}/${lessoncover.split('/').slice(-1).pop()}`;
        relativePath = await downloadUrl(lessoncover, undefined, pathname);
    } else {
        relativePath = await downloadUrl(lessoncover);
    }
    data.lessoncover = resolveUrl(relativePath, `https://${STATIC_URL}/`).toString();

    return data
}

async function updateColumn(table, mysqlValueJson) {
    for (const key of Object.keys(mysqlValueJson)) {
        try {
            if (typeof mysqlValueJson[key] == 'boolean') {
                await db.query(`alter table ${table} add \`${key}\` boolean`);
            }
            else if (typeof mysqlValueJson[key] == 'number') {
                await db.query(`alter table ${table} add \`${key}\` int`);
            }
            else if (typeof mysqlValueJson[key] == 'string' && mysqlValueJson[key].match(/^\d+$/)) {
                await db.query(`alter table ${table} add \`${key}\` int`);
            }
            else if (typeof mysqlValueJson[key] == 'string' && mysqlValueJson[key].length <= 255) {
                await db.query(`alter table ${table} add \`${key}\` varchar(255)`);
            }
            else {
                await db.query(`alter table ${table} add \`${key}\` text`);
            }
        } catch (error) {
            console.log(3, error.sqlMessage);
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

// 添加primaryKey(可选) 将value插入table
async function insertmysqlValueJson(table, valueJson, primaryKey) {
    // 如果不存在 创建表
    try {
        await db.query(`SELECT * FROM ${table} limit 0`);
    } catch (error) {
        await db.query(`create table ${table} (id int primary key)`);
    }

    const mysqlValueJson = Object.assign({}, valueJson);
    if (primaryKey) {
        mysqlValueJson.id = primaryKey;
    }

    // 把object转为string
    for (const key of Object.keys(mysqlValueJson)) {
        if (typeof mysqlValueJson[key] == 'object' && mysqlValueJson[key] != null) {
            mysqlValueJson[key] = JSON.stringify(mysqlValueJson[key]);
        }
    }

    try {
        await db.query(`insert into ${table} set ?`, mysqlValueJson);
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
            console.log(5, error.sqlMessage);
            return
        }
    }
}

async function processValueJson(valueJson, table, primaryKey, valuePathofObject = '', FuncProcessValueJson) {
    // 定位value在json中的路径
    let valueJsonProcessed = {};
    if (valuePathofObject) {
        valueJsonProcessed = _.get(valueJson, valuePathofObject);
    } else {
        valueJsonProcessed = valueJson;
    }
    // 处理value
    if (FuncProcessValueJson) {
        valueJsonProcessed = await FuncProcessValueJson(valueJsonProcessed);
    }

    if (INSERT === true && typeof table === 'string') {
        await insertmysqlValueJson(table, valueJsonProcessed, primaryKey);
    }

    return valueJsonProcessed
}

const PostHeaders = {
    Accept: "*/*",
    "Content-Type": "application/x-www-form-urlencoded",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
    Xweb_xhr: "1"
}
async function fetchValue(URLpathname, URLqueryJson, method = 'GET') {
    // 请求
    const URLQueryString = new URLSearchParams(URLqueryJson).toString();
    let resp = {};
    if (method == 'POST') {
        const full_url = resolveUrl(URLpathname, BASE);
        resp = await fetch(full_url, { method, body: URLQueryString, headers: PostHeaders });
    }
    else if (method == 'GET') {
        const full_url = resolveUrl(URLpathname, BASE, URLQueryString);
        resp = await fetch(full_url)
    }
    else {
        console.log(`method ${method} not supported!`);
        return
    }
    const respJson = await resp.json();

    // 把JSONstring解析为obj
    const valueJson = {};
    for (const key in respJson) {
        if (typeof respJson[key] === 'string') {
            try {
                valueJson[key] = JSON.parse(respJson[key]);
                continue
            } catch (error) { }
        }
        valueJson[key] = respJson[key];
    }

    return valueJson
}

// 根据URL 请求需要的json 可以定位value在json中的路径 然后处理value 作为row插入表 再返回value
async function mysqlSingleRowIndex(URLpathname, URLqueryJson, primaryKey, method = 'GET', valuePathofObject = '', FuncProcessValueJson, table = 'default') {
    const valueJson = await fetchValue(URLpathname, URLqueryJson, method);

    if (table === 'default') {
        table = pathNametoTableName(URLpathname);
    }
    const valueJsonProcessed = await processValueJson(valueJson, table, primaryKey, valuePathofObject, FuncProcessValueJson);

    return valueJsonProcessed
}

// 索引一个Array 把每一项作为json处理 可以定位value在json中的路径 然后处理value 作为row插入表 再返回value
async function mysqlArrayIndex(valueJsonArray, table, primaryKey, valuePathofObject = '', FuncProcessValueJson) {
    const valueJsonArrayProcessed = [];
    for (const valueJson of valueJsonArray) {
        const valueJsonProcessed = await processValueJson(valueJson, table, primaryKey, valuePathofObject, FuncProcessValueJson);
        valueJsonArrayProcessed.push(valueJsonProcessed);
    }
    return valueJsonArrayProcessed
}


// 根据data索引endlesson插入数据库 并返回tabBarList2
async function mysqlEndlessonIndex(data, USER_ID) {
    const EndLessonQueryJson = {
        lessonid: data.lessonid,
        userid: USER_ID
    }
    const { tabBarList2 } = await mysqlSingleRowIndex(URLs.EndLesson, EndLessonQueryJson, data.lessonid);

    return tabBarList2
}

// 根据data索引PrereviewResource插入数据库 提取其中partList的每一个part
async function mysqlPrereviewResourceIndex(data, USER_ID, tabBar) {
    const { name, type } = tabBar;
    const URLQueryJson = {
        classtype: data.classtype,
        classlevel: data.classlevel,
        lessontype: type,
        lessonno: data.lessonno,
        starttime: data.starttime,
        classid: data.classid,
        lessonid: data.lessonid,
        userid: USER_ID
    }
    const PrereviewResource = await mysqlSingleRowIndex(URLs.PrereviewResource, URLQueryJson, `${data.lessonid}${type}`, 'POST', 'data', localizePartUrlClosure(data.lessonname, name));
    let { partList } = PrereviewResource;
    partList = Array.isArray(partList) ? partList : Object.values(partList);

    return partList
}

function writeObjtoJson(relativePath, obj) {
    // 把Obj写入json
    const outputPath = path.join("resourceDownloader", LessonnameSearcher.toString().match(/[a-zA-Z\d]+/).pop(), relativePath);
    // Ensure the directory exists
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(obj));
    console.log(`Saved Obj to ${outputPath}`);
}

// 下载ExamPart中的audio和pic 并返回修改过的ExamPart 因为要传递lessonname和title和tabBarName 所以使用闭包
function localizeExampartClosure(lessonname, title, tabBarName) {
    // 下载ExamPart中的audio和pic 并返回修改过的ExamPart
    const localizeExampart = async (ExamPart) => {
        if (Array.isArray(ExamPart.questions)) {
            // 把ExamPart写入json
            if (READABLE === true) {
                const relativePath = `${lessonname.split('-').slice(0, 2).join('-')}/${tabBarName}/${title}/ExamPart.json`;
                writeObjtoJson(relativePath, ExamPart);
            }

            // 下载ExamPart中的audio和pic
            {
                const { audio, pic } = ExamPart;
                let relativePath = '';
                if (READABLE === true) {
                    // 下载音频
                    if (audio) {
                        const pathname = `${lessonname.split('-').slice(0, 2).join('-')}/${tabBarName}/${title}/${audio}`;
                        relativePath = await downloadUrl(audio, resourceBase, pathname, 'mp3');
                    }
                    // 下载图片
                    if (pic) {
                        for (const singlePic of pic.split(';')) {
                            const pathname = `${lessonname.split('-').slice(0, 2).join('-')}/${tabBarName}/${title}/${singlePic}`;
                            relativePath = await downloadUrl(singlePic, resourceBase, pathname, 'jpg');
                        }
                    }
                } else {
                    if (audio) {
                        relativePath = await downloadUrl(audio);
                    }
                    if (pic) {
                        relativePath = await downloadUrl(pic);
                    }
                }

                // 替换链接
                if (audio) {
                    ExamPart.audio = resolveUrl(relativePath, `https://${STATIC_URL}/`).toString();
                }
                if (pic) {
                    ExamPart.pic = resolveUrl(relativePath, `https://${STATIC_URL}/`).toString();
                }
            }

            // 下载ExamPart中的questions中的audio和pic
            for (const question of ExamPart.questions) {
                const { audio, pic } = question;
                let relativePath = '';
                if (READABLE === true) {
                    // 下载音频
                    if (audio) {
                        const pathname = `${lessonname.split('-').slice(0, 2).join('-')}/${tabBarName}/${title}/${audio}`;
                        relativePath = await downloadUrl(audio, resourceBase, pathname, 'mp3');
                    }
                    // 下载图片
                    if (pic) {
                        for (const singlePic of pic.split(';')) {
                            const pathname = `${lessonname.split('-').slice(0, 2).join('-')}/${tabBarName}/${title}/${singlePic}`;
                            relativePath = await downloadUrl(singlePic, resourceBase, pathname, 'jpg');
                        }
                    }
                } else {
                    if (audio) {
                        relativePath = await downloadUrl(audio);
                    }
                    if (pic) {
                        relativePath = await downloadUrl(pic);
                    }
                }

                // 替换链接
                if (audio) {
                    question.audio = resolveUrl(relativePath, `https://${STATIC_URL}/`).toString();
                }
                if (pic) {
                    question.pic = resolveUrl(relativePath, `https://${STATIC_URL}/`).toString();
                }
            }
        }
        return ExamPart
    }

    return localizeExampart
}

// 下载BookSource中的pageimg和pageaudio 并返回修改过的booksource 因为要传递lessonname和title和tabBarName 所以使用闭包
function localizeBooksourceClosure(lessonname, title, tabBarName) {
    // 下载BookSource中的pageimg和pageaudio 并返回修改过的booksource
    const localizeBooksource = async (BookSource) => {
        if (Array.isArray(BookSource.source)) {
            // 把BookSource写入json
            if (READABLE === true) {
                const relativePath = `${lessonname.split('-').slice(0, 2).join('-')}/${tabBarName}/${title}/BookSource.json`;
                writeObjtoJson(relativePath, BookSource);
            }



            // 下载BookSource中的pageimg和pageaudio
            for (const page of BookSource.source) {
                const { pageaudio, pageimg } = page;
                let relativePath = '';
                if (READABLE === true) {
                    // 下载音频
                    if (pageaudio) {
                        const name = pageaudio.split('/').pop();
                        const pathname = `${lessonname.split('-').slice(0, 2).join('-')}/${tabBarName}/${title}/${name}`;
                        relativePath = await downloadUrl(pageaudio, undefined, pathname, 'mp3');
                    }
                    // 下载图片
                    if (pageimg) {
                        const name = pageimg.split('/').pop();
                        const pathname = `${lessonname.split('-').slice(0, 2).join('-')}/${tabBarName}/${title}/${name}`;
                        relativePath = await downloadUrl(pageimg, undefined, pathname, 'jpg');
                    }
                } else {
                    if (pageaudio) {
                        relativePath = await downloadUrl(pageaudio);
                    }
                    if (pageimg) {
                        relativePath = await downloadUrl(pageimg);
                    }
                }

                // 替换链接
                if (pageaudio) {
                    page.pageaudio = resolveUrl(relativePath, `https://${STATIC_URL}/`).toString();
                }
                if (pageimg) {
                    page.pageimg = resolveUrl(relativePath, `https://${STATIC_URL}/`).toString();
                }
            }
        }
        return BookSource
    }

    return localizeBooksource
}

// 请求datalist 提取每一个data作为row插入数据库*
const LessonnameSearcher = [/^G2B-/];
async function mysqldatalistIndex(URLPathName, URLqueryJson) {
    // 请求处理datalist数组 插入表
    const valueJson = await fetchValue(URLPathName, URLqueryJson);
    let dataArray = [];
    if (typeof valueJson.datalist === 'object') {
        if (Array.isArray(valueJson.datalist)) {
            dataArray = valueJson.datalist;
        }
        else {
            try {
                dataArray = Object.values(valueJson.datalist);
            } catch (err) { }
        }
    }

    // 过滤dataArray中锁定的 选取特定课程名的 并过滤重复的
    const dataArrayProcessed = [];
    for (const data of dataArray) {
        if (data.lock) {
            console.log(1, `${data.lessonid} locked`);
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

        // 去重 过滤同名课程
        if (FORCE === true) {
            dataArrayProcessed.push(data);
        } else {
            const [lessonid] = await db.query(`select lessonname from ${table} where lessonname = ?`, data.lessonname);
            if (!lessonid.length) {
                dataArrayProcessed.push(data);
            }
        }
    }

    // 索引dataArray
    const table = pathNametoTableName(URLPathName);
    await mysqlArrayIndex(dataArrayProcessed, table, undefined, undefined, localizeLessoncoverUrl);

    for (const data of dataArrayProcessed) {
        // 把data写入json
        const { lessonname } = data;
        if (READABLE === true && typeof lessonname === 'string') {
            const relativePath = `${lessonname.split('-').slice(0, 2).join('-')}/data.json`;
            writeObjtoJson(relativePath, data);
        }

        // 根据每个data索引对应的endlesson
        const tabBarList = await mysqlEndlessonIndex(data, URLqueryJson.userid);

        // 根据data和tabBar索引对应的prereviewResource
        for (const tabBar of tabBarList) {
            const partList = await mysqlPrereviewResourceIndex(data, URLqueryJson.userid, tabBar);

            // 把partList写入json
            if (READABLE === true) {
                const relativePath = `${lessonname.split('-').slice(0, 2).join('-')}/${tabBar.name}/partList.json`;
                writeObjtoJson(relativePath, partList);
            }

            for (const part of partList) {
                const { partid, bookid } = part;
                if (partid) {
                    await mysqlSingleRowIndex(URLs.ExamPart, { part_id: partid }, partid, 'POST', 'data', localizeExampartClosure(data.lessonname, part.title, tabBar.name));
                }
                if (bookid) {
                    await mysqlSingleRowIndex(URLs.BookSource, { bookid }, bookid, 'POST', 'data', localizeBooksourceClosure(data.lessonname, part.title, tabBar.name));
                }
            }
        }

    }

    return dataArray
}


const worm = async () => {
    for (const USER of ORIGIN_USER) {
        const [SESSION_ID, USER_ID] = [USER.sessionId, USER.userId];
        for (const URL of [URLs.StartLessonList, URLs.EndLessonList]) {
            const dataArray = await mysqldatalistIndex(URL, { sessionid: SESSION_ID, userid: USER_ID });
            const slug = URL.split('/').pop();
            console.log(`userid: ${USER_ID}, ${slug}: ${dataArray.length}`);
        }
    }
}

worm().then(() => {
    console.log('finished!')
    db.end()
})
