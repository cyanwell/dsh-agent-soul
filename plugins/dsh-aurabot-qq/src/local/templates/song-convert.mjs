// 本地接口 · 翻唱换声：把分离好的人声换成你自己训练的音色（替换内置的 Applio / RVC 推理）。
// 适合：自己训练了 so-vits-svc / DDSP-SVC / 别的 RVC 版本的模型，或者想用自己的推理参数。
// 下载歌曲、分离人声、混音、发语音条还是插件来做，这里只管「人声 → 换成她的声音」这一步。
// 约定见同目录的「README-本地接口.md」。改完保存就生效，不用重启 DSH。
//
// 输入：{ input, output, pitch, voice, voiceFile, indexFile, log }
//   input     分离出来的人声（wav）
//   output    换好声音后要写到的路径（wav）
//   pitch     变调半音（她是女声、原唱是男声时一般 +12）
//   voice     面板里选的音色名（没导入过音色就是空的）
//   voiceFile / indexFile  那个音色导入后的 .pth / .index 路径（没有就是空的）
// 输出：写好 output 后返回 output（或者返回别的 wav 路径）
// 出错就 throw，她会告诉点歌的人没唱成和原因。

import { spawn } from 'node:child_process'

// ↓↓↓ 示例：调用你自己项目的命令行推理。把路径和参数换成你的。
// so-vits-svc 4.x：python inference_main.py -m logs/44k/G_xxx.pth -c configs/config.json -n 输入.wav -t 变调 -s 说话人
// RVC WebUI：python tools/infer_cli.py --input_path 输入 --opt_path 输出 --f0up_key 变调 --model_name 模型.pth --index_path 索引
const PYTHON = 'D:/RVC/runtime/python.exe'
const PROJECT = 'D:/RVC'

export default async function convert({ input, output, pitch, voiceFile, indexFile, log }) {
  const args = ['tools/infer_cli.py', '--input_path', input, '--opt_path', output, '--f0up_key', String(pitch), '--model_name', voiceFile, '--index_path', indexFile || '', '--f0method', 'rmvpe']
  await new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, { cwd: PROJECT, windowsHide: true })
    let tail = ''
    child.stdout.on('data', (b) => { tail = (tail + b).slice(-2000) })
    child.stderr.on('data', (b) => { tail = (tail + b).slice(-2000) })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`推理失败（退出码 ${code}）：${tail.slice(-300)}`))))
  })
  log.info('本地换声完成')
  return output
}
