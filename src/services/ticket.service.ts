import type { Ticket } from '@prisma/client';
import { prisma } from '../core/database';

export async function createTicket(
  chatId: number | bigint,
  userId: number | bigint,
  userName: string | null,
  message: string,
): Promise<Ticket> {
  return prisma.ticket.create({
    data: { chatId: BigInt(chatId), userId: BigInt(userId), userName, message },
  });
}

export async function listOpenTickets(chatId: number | bigint, limit = 15): Promise<Ticket[]> {
  return prisma.ticket.findMany({
    where: { chatId: BigInt(chatId), status: 'open' },
    orderBy: { id: 'asc' },
    take: limit,
  });
}

export async function getTicket(id: number): Promise<Ticket | null> {
  return prisma.ticket.findUnique({ where: { id } });
}

export async function replyTicket(id: number, reply: string): Promise<Ticket> {
  return prisma.ticket.update({ where: { id }, data: { reply, status: 'closed' } });
}

export async function closeTicket(id: number): Promise<Ticket> {
  return prisma.ticket.update({ where: { id }, data: { status: 'closed' } });
}

export async function openTicketCount(chatId: number | bigint): Promise<number> {
  return prisma.ticket.count({ where: { chatId: BigInt(chatId), status: 'open' } });
}
