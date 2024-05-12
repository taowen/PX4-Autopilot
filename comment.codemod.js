const { DEEPSEEK_API_KEY } = vscode.workspace.getConfiguration('taowen.repo-to-prompt')
if (!DEEPSEEK_API_KEY) {
    vscode.window.showInformationMessage('please set taowen.repo-to-prompt.DEEPSEEK_API_KEY in your settings.json')
    return;
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

async function commentFile(inputFile, outputFile) {
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

async function walkDirectory(uri) {
    const children = await vscode.workspace.fs.readDirectory(uri);
    for (const [name, type] of children) {
        if (name.startsWith('.') || name === 'node_modules' || name === 'pnpm-lock.yaml') {
            continue;
        }
        const childUri = vscode.Uri.joinPath(uri, name);
        if (type === vscode.FileType.Directory) {
            await walkDirectory(childUri);
        } else if (type === vscode.FileType.File && (name.endsWith('.c') || name.endsWith('.cpp'))) {
            const relPath = vscode.workspace.asRelativePath(childUri)
            if (relPath.includes('test')) {
                continue
            }
            await commentFile(childUri, vscode.Uri.joinPath(uri, name + '.comment'))
        }
    }
}

await walkDirectory(vscode.Uri.joinPath(rootDir, 'src/modules/ekf2'))

