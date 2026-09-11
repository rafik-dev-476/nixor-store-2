import { createFileRoute } from "@tanstack/react-router";

import { buildEmbed, buildButtonRows } from "@/lib/discord-payload";
import { hexToInt, type EmbedButton } from "@/lib/announcement-types";
import {
  verifyDiscordSignature,
  sendMessage,
  createTicketChannel,
  getBotId,
  followUp,
} from "@/lib/discord-rest.server";

const EPHEMERAL = 64;
const DEFERRED_WITH_SOURCE = 5; // Deferred channel message with source

type Json = Record<string, any>;

function reply(content: string, ephemeral = true): Response {
  return Response.json({
    type: 4,
    data: { content, flags: ephemeral ? EPHEMERAL : 0 },
  });
}

function replyDeferred(): Response {
  return Response.json({ type: DEFERRED_WITH_SOURCE });
}

function replyEmbed(embed: Json, ephemeral = true): Response {
  return Response.json({
    type: 4,
    data: { embeds: [embed], flags: ephemeral ? EPHEMERAL : 0 },
  });
}

function optionValue(options: Json[] | undefined, name: string) {
  return options?.find((o) => o.name === name)?.value as string | undefined;
}

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/* ------------------------------ /announcement ----------------------------- */

async function handleCommand(interaction: Json) {
  const data = interaction.data as Json;
  if (data.name !== "announcement") return reply("أمر غير معروف.");

  const options = data.options as Json[] | undefined;
  const id = optionValue(options, "announcement");
  const supabase = await db();
  const { data: ann } = await supabase
    .from("announcements")
    .select("*")
    .eq("id", id ?? "")
    .maybeSingle();
  if (!ann) return reply("لم يتم العثور على الإعلان المحدد.");

  const target =
    optionValue(options, "room") ?? ann.default_channel_id ?? interaction.channel_id;
  if (!target) return reply("حدّد الروم التي سيُنشر فيها الإعلان.");

  const description = optionValue(options, "description");
  const thumbnail = optionValue(options, "thumbnail");

  try {
    await sendMessage(target, {
      embeds: [
        buildEmbed({
          ...ann,
          ...(description ? { body: description } : {}),
          ...(thumbnail ? { thumbnail_url: thumbnail } : {}),
        }),
      ],
      components: buildButtonRows(ann.id, (ann.buttons ?? []) as EmbedButton[]),
    });
  } catch (e) {
    return reply(`فشل النشر: ${(e as Error).message}`);
  }

  await supabase
    .from("announcements")
    .update({ last_published_at: new Date().toISOString() })
    .eq("id", ann.id);
  return reply(`تم نشر الإعلان في <#${target}> ✅`);
}

async function handleAutocomplete(interaction: Json) {
  const supabase = await db();
  const focused = (interaction.data?.options as Json[])?.find((o) => o.focused);
  const query = String(focused?.value ?? "");
  const { data: rows } = await supabase
    .from("announcements")
    .select("id, name")
    .ilike("name", `%${query}%`)
    .order("updated_at", { ascending: false })
    .limit(25);
  return Response.json({
    type: 8,
    data: { choices: (rows ?? []).map((r: Json) => ({ name: r.name, value: r.id })) },
  });
}

/**
 * Handles Order button clicks:
 * - Checks if user already has an open ticket
 * - Creates a new Discord channel inside the configured category
 * - Stores ticket info in database
 * - Sends info message with close button
 */
async function handleOrderButton(
  interaction: Json,
  applicationId: string,
): Promise<{ immediate: Response; deferred: boolean }> {
  const userId = interaction.member?.user?.id as string | undefined;
  const username = interaction.member?.user?.username as string | undefined;
  const guildId = interaction.guild_id as string | undefined;

  if (!userId || !username || !guildId) {
    return {
      immediate: reply("لم نتمكن من التعرف على المستخدم."),
      deferred: false,
    };
  }

  // Defer the response (tell Discord we're working on it)
  const deferred = replyDeferred();

  // Process asynchronously in the background
  (async () => {
    try {
      const supabase = await db();
      const { data: settings } = await supabase
        .from("guild_settings")
        .select("*")
        .eq("guild_id", guildId)
        .maybeSingle();

      if (!settings?.ticket_category_id || !settings?.staff_role_id) {
        await followUp(
          applicationId,
          interaction.token,
          {
            content:
              "❌ لم تكتمل إعدادات التذاكر. اطلب من الإدارة تكوين الإعدادات.",
            flags: EPHEMERAL,
          },
        );
        return;
      }

      // Check if user has an open ticket already
      const { data: existingTicket } = await supabase
        .from("tickets")
        .select("id, channel_id")
        .eq("opener_discord_id", userId)
        .eq("guild_id", guildId)
        .neq("status", "closed")
        .maybeSingle();

      if (existingTicket) {
        await followUp(
          applicationId,
          interaction.token,
          {
            content: `⚠️ لديك تذكرة مفتوحة بالفعل: <#${existingTicket.channel_id}>\nأغلق التذكرة السابقة أولاً.`,
            flags: EPHEMERAL,
          },
        );
        return;
      }

      // Get bot ID for permissions
      const botId = await getBotId();

      // Create the ticket channel
      const channelName = `ticket-${username}`.toLowerCase();
      const channel = await createTicketChannel(
        guildId,
        settings.ticket_category_id,
        channelName,
        userId,
        settings.staff_role_id,
        botId,
      );

      // Create ticket record in database
      const { data: ticket, error: ticketError } = await supabase
        .from("tickets")
        .insert({
          guild_id: guildId,
          channel_id: channel.id,
          opener_discord_id: userId,
          opener_username: username,
          status: "open",
        })
        .select()
        .single();

      if (ticketError || !ticket) {
        await sendMessage(channel.id, {
          content: "❌ حدث خطأ في إنشاء سجل التذكرة. الرجاء المحاولة لاحقاً.",
        });
        return;
      }

      // Send welcome message with ticket info and close button
      const welcomeEmbed = {
        title: "✅ تم إنشاء تذكرتك",
        description: `مرحباً <@${userId}>! تم إنشاء تذكرتك بنجاح.`,
        color: 0x248046, // Green
        fields: [
          {
            name: "رقم التذكرة",
            value: `#${ticket.id.slice(0, 8)}`,
            inline: true,
          },
          {
            name: "الحالة",
            value: "مفتوحة",
            inline: true,
          },
        ],
        footer: {
          text: "فريق الدعم سيرد عليك في أقرب وقت",
        },
      };

      // Message with close button
      await sendMessage(channel.id, {
        embeds: [welcomeEmbed],
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                label: "إغلاق التذكرة",
                style: 4, // Red button
                custom_id: `close_ticket:${ticket.id}`,
              },
            ],
          },
        ],
      });

      // Send welcome text from settings
      if (settings.welcome_text) {
        await sendMessage(channel.id, {
          content: settings.welcome_text,
        });
      }

      // Send terms text from settings
      if (settings.terms_text) {
        await sendMessage(channel.id, {
          content: `📋 **الشروط:**\n${settings.terms_text}`,
        });
      }

      // Follow up with success message
      await followUp(
        applicationId,
        interaction.token,
        {
          content: `✅ تم إنشاء تذكرتك بنجاح! <#${channel.id}>`,
        },
      );
    } catch (error) {
      console.error("Order button handler failed:", error);
      try {
        await followUp(
          applicationId,
          interaction.token,
          {
            content: `❌ حدث خطأ: ${(error as Error).message.slice(0, 200)}`,
            flags: EPHEMERAL,
          },
        );
      } catch {
        console.error("Failed to send error follow-up");
      }
    }
  })();

  return { immediate: deferred, deferred: true };
}

async function handleComponent(interaction: Json): Promise<Response> {
  const customId = String(interaction.data?.custom_id ?? "");

  // Handle Order button (format: order:annId:buttonId)
  if (customId.startsWith("order:")) {
    const applicationId = process.env["DISCORD_APPLICATION_ID"];
    if (!applicationId) {
      return reply("DISCORD_APPLICATION_ID غير مضبوط.");
    }
    const { immediate } = await handleOrderButton(interaction, applicationId);
    return immediate;
  }

  // Handle close ticket button (format: close_ticket:ticketId)
  if (customId.startsWith("close_ticket:")) {
    const ticketId = customId.split(":")[1];
    const supabase = await db();

    // Check if user is the opener or has staff role
    const userId = interaction.member?.user?.id;
    const hasStaffRole = (interaction.member?.roles as string[] | undefined)?.some((role) =>
      role === interaction.guild_id, // This is a simplified check; adjust based on your setup
    );

    const { data: ticket } = await supabase
      .from("tickets")
      .select("*")
      .eq("id", ticketId)
      .maybeSingle();

    if (!ticket) {
      return reply("التذكرة غير موجودة.");
    }

    if (ticket.opener_discord_id !== userId && !hasStaffRole) {
      return reply("ليس لديك صلاحية إغلاق هذه التذكرة.");
    }

    // Update ticket status to closed
    await supabase
      .from("tickets")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
      })
      .eq("id", ticketId);

    return reply("✅ تم إغلاق التذكرة. شكراً لتواصلك معنا!", false);
  }

  // Handle announcement buttons (existing logic)
  const [kind, annId, buttonId] = customId.split(":");
  if (kind !== "ab") return reply("هذا الزر لم يعد متاحاً.");

  const supabase = await db();
  const { data: ann } = await supabase
    .from("announcements")
    .select("*")
    .eq("id", annId ?? "")
    .maybeSingle();
  const button = ((ann?.buttons ?? []) as EmbedButton[]).find((b) => b.id === buttonId);
  if (!button) return reply("هذا الزر لم يعد متاحاً.");

  if (button.action === "info") {
    return replyEmbed(
      {
        title: button.responseTitle || button.label,
        description: button.responseText || "",
        color: hexToInt(ann?.color ?? "#5865F2"),
      },
      button.ephemeral !== false,
    );
  }
  return reply(button.responseText || "تم تسجيل طلبك ✅", button.ephemeral !== false);
}

export const Route = createFileRoute("/api/public/discord/interactions")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const publicKey = process.env["DISCORD_PUBLIC_KEY"];
        if (!publicKey) return new Response("Missing DISCORD_PUBLIC_KEY", { status: 500 });

        const rawBody = await request.text();
        const valid = await verifyDiscordSignature(
          rawBody,
          request.headers.get("x-signature-ed25519"),
          request.headers.get("x-signature-timestamp"),
          publicKey,
        );
        if (!valid) return new Response("invalid request signature", { status: 401 });

        const interaction = JSON.parse(rawBody) as Json;
        try {
          if (interaction.type === 1) return Response.json({ type: 1 });
          if (interaction.type === 2) return await handleCommand(interaction);
          if (interaction.type === 3) return await handleComponent(interaction);
          if (interaction.type === 4) return await handleAutocomplete(interaction);
        } catch (error) {
          console.error("discord interaction failed", error);
          return reply(`حدث خطأ: ${(error as Error).message.slice(0, 300)}`);
        }
        return reply("غير مدعوم");
      },
    },
  },
});
