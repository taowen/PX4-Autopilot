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

const lines = []
rankings = ['```json']
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
        } else if (type === vscode.FileType.File && name.endsWith('.comment')) {
            const relPath = vscode.workspace.asRelativePath(childUri).replace('.comment', '')
            rankings.push(`"explain why ${relPath} is related to the user question?": "explanation",`)
            rankings.push(`"${relPath}": n,`)
            lines.push(`<file path="${relPath}">`)
            lines.push(await readFile(childUri))
            lines.push('</file>')
        }
    }
}

await walkDirectory(vscode.Uri.joinPath(rootDir, 'src/modules/ekf2'))
rankings.push('```')
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
${lines.join('\n')}

<user-question>
欧拉角的状态是怎么估计的？
</user-question>

为了回答用户的问题，给每个文件和问题的相关程度打一个 0 ~ 5 的分数。以 JSON 的格式输出。

${rankings.join('\n')}
`}
        ]
        })
})
const respJson = await resp.json()
console.log(respJson.choices[0].message.content)
