using System;
using Azure.Storage.Queues.Models;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;

namespace Zenda.Functions;

public class QueueTrigger1
{
    private readonly ILogger<QueueTrigger1> _logger;

    public QueueTrigger1(ILogger<QueueTrigger1> logger)
    {
        _logger = logger;
    }

    [Function(nameof(QueueTrigger1))]
    public void Run([QueueTrigger("incoming-messages", Connection = "zendablobqueue_STORAGE")] QueueMessage message)
    {
        _logger.LogInformation("C# Queue trigger function processed: {messageText}", message.MessageText);
        // log message to data base
        // if fromMe = false -> send to logic dispatcher queue
    }
}