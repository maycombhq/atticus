package tide.cards;

import org.springframework.jms.annotation.JmsListener;
import org.springframework.jms.core.JmsTemplate;
import org.springframework.kafka.core.KafkaTemplate;

public class CardEvents {
  private final KafkaTemplate<String, Object> kafkaTemplate;
  private final JmsTemplate jmsTemplate;

  public void issued(Card c) {
    kafkaTemplate.send(Topics.CARD_ISSUED, c);
  }

  public void order(Order o) {
    jmsTemplate.convertAndSend(Queues.ORDERS, o);
  }

  @JmsListener(destination = "CARDS.REPLY")
  public void reply(String message) {}
}
