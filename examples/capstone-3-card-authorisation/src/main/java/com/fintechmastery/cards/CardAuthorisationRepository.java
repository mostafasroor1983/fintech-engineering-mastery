package com.fintechmastery.cards;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface CardAuthorisationRepository extends JpaRepository<CardAuthorisation, Long> {

    Optional<CardAuthorisation> findByPublicId(UUID publicId);
}
