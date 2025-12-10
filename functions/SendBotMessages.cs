using System;
using System.Text.Json;
using System.Threading.Tasks;
using Azure.Storage.Queues;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace Zenda.Functions
{
    public class SendBotMessage
    {
        private readonly QueueClient _queue;

        public SendBotMessage()
        {
            var conn = Environment.GetEnvironmentVariable("zendablobqueue_STORAGE");
            if (string.IsNullOrWhiteSpace(conn))
                throw new Exception("❌ zendablobqueue_STORAGE is missing");

            // Новый QueueClient
            _queue = new QueueClient(conn, "outgoing-messages");

            // Создаём очередь, если её нет
            _queue.CreateIfNotExists();
        }

        [Function("SendBotMessage")]
        public async Task<HttpResponseData> Run(
            [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "send")] HttpRequestData req)
        {
            var query = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            var chatId = query["chatId"];
            var text = query["text"] ?? "pong";

            if (string.IsNullOrWhiteSpace(chatId))
            {
                var bad = req.CreateResponse(System.Net.HttpStatusCode.BadRequest);
                await bad.WriteStringAsync("Missing chatId parameter");
                return bad;
            }

            // -------------------------
            // Формируем payload
            // -------------------------
            var payload = new
            {
                chatId = chatId,
                sender = "125829791129672@lid",
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                type = "text",
                text = text,
                mediaUrl = (string?)null,
                mime = (string?)null,
                fromMe = true
            };

            string json = JsonSerializer.Serialize(payload);

            // -------------------------
            // Кладём в outgoing-messages
            // -------------------------
            await _queue.SendMessageAsync(json);

            // Ответ клиенту
            var ok = req.CreateResponse(System.Net.HttpStatusCode.OK);
            await ok.WriteStringAsync($"Sent to outgoing-messages: {json}");
            return ok;
        }
    }
}
