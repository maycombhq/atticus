package forge.payments.api;

import forge.payments.Payment;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;

@Mapper
public interface PaymentMapper {
  @Mapping(source = "id", target = "paymentId")
  PaymentView toView(Payment payment);
}
