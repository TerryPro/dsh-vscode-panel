/** 与 DSH 图标体系一致的终端入口图标。 */

/**
 * 终端图标就住在 `CreateEntryIcons` 里，因为它与「新建文件」「新建文件夹」「新建 SQL 笔记」共有一套形制
 * （矩形轮廓 + 填充分面 + 1.2 描边）和一个缩放规则，而那三支的说明也在那里。这里只保留本模块原来的
 * 导入面，免得十几个调用点各记一个不同的出处。
 */
export {
  IconTerminalAddOutline16,
  IconTerminalOutline16,
} from '../files/CreateEntryIcons.tsx'
