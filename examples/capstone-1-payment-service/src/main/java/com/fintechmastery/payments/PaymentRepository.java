package com.fintechmastery.payments;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PaymentRepository extends JpaRepository<Payment, Long> {

    Optional<Payment> findByPublicId(UUID publicId);

    Optional<Payment> findByPublicIdAndMerchantId(UUID publicId, String merchantId);
}
