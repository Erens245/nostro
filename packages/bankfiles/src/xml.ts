// A small tree over saxes, plus the string helpers our writers share.
//
// Payment files arrive from outside, so parsing is defensive: a DOCTYPE is
// refused outright, which rules out entity-expansion attacks and any fetch of
// an external resource. saxes itself never touches the network or the disk.

import { SaxesParser } from 'saxes';

export interface XmlNode {
  local: string;
  uri: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const MAX_CHARS = 20 * 1024 * 1024;
const MAX_DEPTH = 64;

export function parseXml(xml: string): XmlNode {
  if (xml.length > MAX_CHARS) throw new Error('This file is too large to read.');

  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;

  parser.on('doctype', () => {
    throw new Error('This file contains a DOCTYPE, which payment files never need.');
  });
  parser.on('error', (error) => {
    throw error;
  });
  parser.on('opentag', (tag) => {
    if (stack.length >= MAX_DEPTH) throw new Error('This file is nested too deeply.');
    const attrs: Record<string, string> = {};
    for (const attribute of Object.values(tag.attributes)) {
      attrs[attribute.local] = attribute.value;
    }
    const node: XmlNode = {
      local: tag.local,
      uri: tag.uri,
      attrs,
      children: [],
      text: '',
    };
    stack.at(-1)?.children.push(node);
    root ??= node;
    stack.push(node);
  });
  parser.on('text', (text) => {
    const top = stack.at(-1);
    if (top) top.text += text;
  });
  parser.on('closetag', () => {
    stack.pop();
  });

  parser.write(xml.replace(/^﻿/, '')).close();
  if (!root) throw new Error('This file has no XML content.');
  return root;
}

export function kid(node: XmlNode | undefined, local: string): XmlNode | undefined {
  return node?.children.find((child) => child.local === local);
}

export function kids(node: XmlNode | undefined, local: string): XmlNode[] {
  return node?.children.filter((child) => child.local === local) ?? [];
}

export function at(node: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  return path.reduce<XmlNode | undefined>((current, local) => kid(current, local), node);
}

export function textAt(node: XmlNode | undefined, ...path: string[]): string | undefined {
  const value = at(node, ...path)?.text.trim();
  return value ? value : undefined;
}

/** Control characters are illegal in XML 1.0, and a tab or newline breaks a field. */
export function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
}

export function escapeXml(value: string): string {
  return cleanText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function clip(value: string, max: number): string {
  return [...cleanText(value)].slice(0, max).join('');
}

type Child = string | null | undefined | false;

/** An element with text content. A missing value writes nothing at all. */
export function leaf(
  name: string,
  value: string | null | undefined,
  attrs?: Record<string, string>,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  return `<${name}${renderAttrs(attrs)}>${escapeXml(value)}</${name}>`;
}

/** An element holding other elements, with each child indented on its own line. */
export function group(name: string, ...children: Child[]): string | null {
  const body = children.filter((child): child is string => Boolean(child));
  if (body.length === 0) return null;
  const inner = body
    .join('\n')
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  return `<${name}>\n${inner}\n</${name}>`;
}

function renderAttrs(attrs?: Record<string, string>): string {
  if (!attrs) return '';
  return Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('');
}

export function document(namespace: string, body: string | null): string {
  if (!body) throw new Error('An empty document cannot be written.');
  const inner = body
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Document xmlns="${namespace}">\n${inner}\n</Document>\n`
  );
}
