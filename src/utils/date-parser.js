'use strict';

/**
 * Converte datas em PT-BR para timestamps Unix.
 * Suporta: "DD/MM/AAAA", "setembro", "semana que vem", "mês que vem", etc.
 */

const MONTHS_PT = {
  janeiro: 0, fevereiro: 1, março: 2, abril: 3,
  maio: 4, junho: 5, julho: 6, agosto: 7,
  setembro: 8, outubro: 9, novembro: 10, dezembro: 11,
  // sem acento
  marco: 2,
};

/**
 * Converte due_date (string DD/MM/AAAA) ou due_days (number) em timestamp Unix.
 * Retorna null se não conseguir parsear.
 */
function resolveTaskDueDate(task) {
  if (!task) return null;

  // due_date absoluta tem prioridade: "01/09/2026"
  if (task.due_date) {
    const ts = parsePtDate(task.due_date);
    if (ts) return ts;
  }

  // due_days relativo
  if (typeof task.due_days === 'number' && task.due_days >= 0) {
    return Math.floor(Date.now() / 1000) + task.due_days * 86400;
  }

  // fallback: amanhã
  return Math.floor(Date.now() / 1000) + 86400;
}

/**
 * Parseia data em formato "DD/MM/AAAA" ou "DD/MM/AA".
 * Retorna timestamp Unix ou null.
 */
function parsePtDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;

  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  let year = parseInt(parts[2], 10);
  if (year < 100) year += 2000;

  const d = new Date(year, month, day, 9, 0, 0);
  if (isNaN(d.getTime())) return null;

  // Se a data já passou, avança 1 ano
  if (d < new Date()) d.setFullYear(d.getFullYear() + 1);

  return Math.floor(d.getTime() / 1000);
}

/**
 * Detecta menção de data futura em texto PT-BR e retorna timestamp.
 * Usado para parsear "retorno em setembro", "próxima semana", etc.
 */
function detectDateMention(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const now = new Date();

  // Mês específico: "em setembro", "para setembro", "retorno setembro"
  for (const [name, idx] of Object.entries(MONTHS_PT)) {
    if (t.includes(name)) {
      const d = new Date(now.getFullYear(), idx, 1, 9, 0, 0);
      if (d <= now) d.setFullYear(d.getFullYear() + 1);
      return Math.floor(d.getTime() / 1000);
    }
  }

  // Próxima semana / semana que vem
  if (t.includes('próxima semana') || t.includes('semana que vem') || t.includes('proxima semana')) {
    return Math.floor(Date.now() / 1000) + 7 * 86400;
  }

  // Próximo mês / mês que vem
  if (t.includes('próximo mês') || t.includes('mes que vem') || t.includes('mês que vem')) {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, 1, 9, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  // Início do ano / ano que vem
  if (t.includes('início do ano') || t.includes('ano que vem') || t.includes('começo do ano')) {
    return Math.floor(new Date(now.getFullYear() + 1, 0, 5, 9, 0, 0).getTime() / 1000);
  }

  // Depois das férias (julho/agosto)
  if (t.includes('férias') || t.includes('ferias')) {
    const d = new Date(now.getFullYear(), 7, 10, 9, 0, 0); // 10 de agosto
    if (d <= now) d.setFullYear(d.getFullYear() + 1);
    return Math.floor(d.getTime() / 1000);
  }

  // Depois do carnaval
  if (t.includes('carnaval')) {
    // Carnaval varia, aproximamos para março
    const d = new Date(now.getFullYear(), 2, 6, 9, 0, 0); // 6 de março
    if (d <= now) d.setFullYear(d.getFullYear() + 1);
    return Math.floor(d.getTime() / 1000);
  }

  return null;
}

module.exports = { resolveTaskDueDate, parsePtDate, detectDateMention };
