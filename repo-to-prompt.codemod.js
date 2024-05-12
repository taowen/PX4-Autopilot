const USER_QUESTION = '怎么避免坠毁到陆地上？哪个函数负责的？'
const SEARCH_IN_DIRS = ['src/modules/landing_target_estimator', 'src/modules/land_detector']
const { DEEPSEEK_API_KEY } = vscode.workspace.getConfiguration('taowen.repo-to-prompt')
if (!DEEPSEEK_API_KEY) {
    vscode.window.showInformationMessage('please set taowen.repo-to-prompt.DEEPSEEK_API_KEY in your settings.json')
    return;
}

const JSON_START = '```json'
const JSON_END = '```'
const MAX_CONCURRENT_JOBS = 10
const concurrentJobs = new Set()

async function limitedFetch(input, init) {
    while(true) {
        if (concurrentJobs.size < MAX_CONCURRENT_JOBS) {
            const myJob = fetch(input, init);
            concurrentJobs.add(myJob);
            try {
                return await myJob;
            } finally {
                concurrentJobs.delete(myJob);
            }
        } else {
            await Promise.any(Array.from(concurrentJobs));
        }
    }
}

const utf8decoder = new TextDecoder()
const utf8encoder = new TextEncoder()
const rootDir = vscode.workspace.workspaceFolders[0].uri
async function readFile(file) {
    return utf8decoder.decode(await vscode.workspace.fs.readFile(file)).replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')
}


async function commentFileContentPart(code) {
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            "model": "deepseek-chat",
            "messages": [
              {"role": "user", "content": `
<code>${code}</code>
用三句话概括这份代码对什么状态数据做了什么业务操作
    `}
            ]
          })
    })
    return await resp.json()
}

async function commentFileContentParts(parts) {
    let outputContent = ''
    for (const part of parts) {
        const respJson = await commentFileContentPart(part)
        if (respJson.detail && respJson.detail.includes('Please reduce the length')) {
            return [false, '']
        }
        outputContent += respJson.choices[0].message.content
        outputContent += '\n'
    }
    return [true, outputContent]
}

function splitStringIntoParts(str, partsCount) {
    const n = str.length;
    const partLength = Math.floor(n / partsCount);
    const parts = [];

    for (let i = 0; i < partsCount; i++) {
        const start = i * partLength;
        const end = i === (partsCount - 1) ? n : (i + 1) * partLength;
        parts.push(str.substring(start, end));
    }

    return parts;
}

async function writeCommentFile(inputFile, outputFile) {
    try {
        await readFile(outputFile);
        return;
    } catch {
        // ignore
    }
    const inputContent = await readFile(inputFile);
    console.log(inputFile.path)
    for(let partsCount = 1; partsCount < 10; partsCount++) {
        const parts = splitStringIntoParts(inputContent, partsCount)
        const [success, outputContent] = await commentFileContentParts(parts)
        if(success) {
            console.log(outputContent)
            await vscode.workspace.fs.writeFile(outputFile, utf8encoder.encode(outputContent))
            return
        } else {
            console.log('切成' + partsCount + '份处理失败，重试')
        }
    }
    console.log('文件太大处理失败')
}

async function isFileRelated(relPath, inputContent) {
    const rankings = [
        '```json',
        '{',
        '"这份代码为什么和用户的问题相关？": "解释",',
        '"score": 0 ~ 5',
        '}',
        '```'
    ]
    const resp = await limitedFetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            "model": "deepseek-chat",
            "messages": [
                {"role": "user", "content": `
<code file_path="${relPath}">
${inputContent}
</code>

<user-question>
${USER_QUESTION}
</user-question>

为了回答用户的问题，给这份代码和问题的相关程度打一个 0 ~ 5 的分数。以 JSON 的格式输出。不要解释

${rankings.join('\n')}
    `}
            ]
            })
    })
    const respJson = await resp.json()
    let jsonContent = respJson.choices[0].message.content
    if (jsonContent.indexOf('{') === -1) {
        throw new Error('{ not found');
    }
    if (jsonContent.lastIndexOf('}') === -1) {
        throw new Error('} not found');
    }
    jsonContent = jsonContent.substring(jsonContent.indexOf('{'), jsonContent.indexOf('}') + 1)
    jsonContent = JSON.parse(jsonContent)
    return jsonContent.score > 2
}

async function extractCodePart(code) {
    const resp = await limitedFetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            "model": "deepseek-chat",
            "messages": [
                {"role": "user", "content": `
<code>
${code}
</code>

<user-question>
${USER_QUESTION}
</user-question>

按下面的 XML 格式输出，不要额外解释

<has_relevant_code>

true / false

<if_true>
列举所有与用户问题相关的代码，描述其输入的来源与输出的下游
</if_true>
<if_false>
不用解释了
</if_false>

</has_relevant_code>
    `}
            ]
            })
    })
    const respJson = await resp.json()
    if (respJson.detail && respJson.detail.includes('Please reduce the length')) {
        return [false, '']
    }
    xmlContent = respJson.choices[0].message.content
    if (xmlContent.indexOf('<has_relevant_code>') === -1) {
        throw new Error('<has_relevant_code> not found')
    }
    if (xmlContent.indexOf('</has_relevant_code>') === -1) {
        throw new Error('</has_relevant_code> not found')
    }
    xmlContent = xmlContent.substring(xmlContent.indexOf('<has_relevant_code>') + '<has_relevant_code>'.length, xmlContent.indexOf('</has_relevant_code>'))
    xmlContent = xmlContent.trim()
    if (xmlContent.startsWith('false')) {
        return [true, '']
    }
    if (xmlContent.indexOf('<if_true>') !== -1 && xmlContent.indexOf('</if_true>') !== -1) {
        xmlContent = xmlContent.substring(xmlContent.indexOf('<if_true>') + '<if_true>'.length, xmlContent.indexOf('</if_true>'))
    }
    return [true, xmlContent]
}

async function extractCodeParts(relPath, parts) {
    let outputContent = ''
    for (const part of parts) {
        const [success, partOutput] = await extractCodePart(part)
        if (!success) {
            return [false, '']
        }
        outputContent += partOutput
        outputContent += '\n'
    }
    if (outputContent.trim()) {
        return [true, `<file path="${relPath}">\n${outputContent.trim()}\n</file>`]
    } else {
        return [true, '']
    }
}


function splitStringIntoParts(str, partsCount) {
    const n = str.length;
    const partLength = Math.floor(n / partsCount);
    const parts = [];

    for (let i = 0; i < partsCount; i++) {
        const start = i * partLength;
        const end = i === (partsCount - 1) ? n : (i + 1) * partLength;
        parts.push(str.substring(start, end));
    }

    return parts;
}

async function processFile(inputFile, commentFile) {
    const relPath = vscode.workspace.asRelativePath(inputFile)
    await writeCommentFile(inputFile, commentFile)
    if (!await isFileRelated(relPath, await readFile(commentFile))) {
        console.log(relPath + ' 通过 comment 判断不含相关内容')
        return
    }
    console.log(relPath + ' 可能有关，尝试提取代码')
    const code = await readFile(vscode.Uri.joinPath(rootDir, relPath));
    for(let partsCount = 1; partsCount < 10; partsCount++) {
        const parts = splitStringIntoParts(code, partsCount)
        const [success, outputContent] = await extractCodeParts(relPath, parts)
        if(success) {
            if (outputContent) {
                console.log(outputContent)
            } else {
                console.log(relPath + ' 不含相关内容')
            }
            return outputContent
        } else {
            console.log(relPath + ' 切成' + partsCount + '份处理失败，重试')
        }
    }
    console.log(relPath + ' 文件太大处理失败')
    return ''
}

const processFilePromises = []
async function walkDirectory(uri) {
    const children = await vscode.workspace.fs.readDirectory(uri);
    for (const [name, type] of children) {
        if (name.startsWith('.') || name === 'node_modules' || name === 'pnpm-lock.yaml') {
            continue;
        }
        const childUri = vscode.Uri.joinPath(uri, name);
        if (type === vscode.FileType.Directory) {
            if (name.includes('test')) {
                continue
            }
            await walkDirectory(childUri);
        } else if (type === vscode.FileType.File && (name.endsWith('.c') || name.endsWith('.cpp'))) {
            processFilePromises.push(processFile(childUri, vscode.Uri.joinPath(uri, name + '.comment')))
        }
    }
}


for (const searchInDir of SEARCH_IN_DIRS) {
    await walkDirectory(vscode.Uri.joinPath(rootDir, searchInDir))
}
try {
    let relatedContents = await Promise.all(processFilePromises)
    relatedContents = relatedContents.filter(e => e)
    console.log(`==== ask final question: ${relatedContents.join('\n').length} ====`)
    const resp = await limitedFetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            "model": "deepseek-chat",
            "messages": [
                {"role": "user", "content": `
${relatedContents.join('\n')}

综合上述文件的内容，${USER_QUESTION}
`}]
            })
    })
    const respJson = await resp.json()
    console.log(respJson.choices[0].message.content)
} catch(e) {
    console.log('failed', e)
}
