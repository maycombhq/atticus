package forge.fraud;

import io.smallrye.mutiny.Multi;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import org.eclipse.microprofile.reactive.messaging.Channel;
import org.eclipse.microprofile.reactive.messaging.Emitter;
import org.eclipse.microprofile.reactive.messaging.Incoming;
import org.eclipse.microprofile.reactive.messaging.Outgoing;

@ApplicationScoped
public class FraudScorer {

    @Inject
    @Channel("alerts")
    Emitter<FraudAlert> alerts;

    @Inject
    @Channel("audit-stream")
    Multi<AuditEvent> audit;

    @Incoming("payments-in")
    @Outgoing("fraud-scores")
    public Score score(Payment payment) {
        return Score.of(payment);
    }
}
